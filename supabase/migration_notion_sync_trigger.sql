-- ============================================================================
-- MIGRATION: Atomic Notion-sync enqueueing via a database trigger
-- ============================================================================
-- Date: 2026-05-19
-- Idempotent — safe to run more than once.
--
-- THE BUG THIS FIXES
--   Adding / editing / deleting a highlight used to perform TWO independent
--   network writes from the browser:
--     1. write the row in `highlights`
--     2. enqueue a row in `notion_sync_queue` (via POST /api/notion/queue)
--   These were never atomic. If write #1 committed server-side but the client
--   never saw the acknowledgement (dropped connection, backgrounded tab, a 5xx
--   on the *response* of an otherwise-successful write), the catch block fired
--   ("Failed to add highlight") and write #2 never ran. Result: a highlight in
--   Supabase with NO matching queue row. The two tables disagree permanently,
--   which wedges Notion sync until `notion_sync_queue` is hand-edited.
--   Ordering the two writes (enqueue only after the row write succeeds) does
--   NOT fix this — the failure is *between* two non-atomic operations.
--
-- THE FIX
--   Enqueueing now happens inside an AFTER INSERT/UPDATE/DELETE trigger on
--   `highlights`. The queue row is written in the SAME TRANSACTION as the
--   highlight change, so the two tables commit together or roll back together.
--   It is physically impossible for one to land without the other, regardless
--   of what the client does or sees. Every write path — current and future —
--   is covered automatically; no call site can forget to enqueue.
--
--   This trigger fully replaces POST /api/notion/queue. It reproduces that
--   route's behaviour: the Notion-enabled gate, pending-entry de-duplication,
--   and the delete-after-add short-circuit.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Flag highlights that were imported FROM Notion.
-- ----------------------------------------------------------------------------
-- Such highlights already exist on the Notion page, so the trigger must NOT
-- enqueue an 'add' for them (that would duplicate them in Notion). The import
-- routes set this to TRUE. Later edits / deletes of these rows still sync
-- normally — only the initial INSERT is suppressed.
ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS imported_from_notion BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-edit opt-out for the "Don't sync to Notion" checkbox. An edit handler
-- writes a fresh value here (alongside text/html) ONLY when the box is ticked;
-- ordinary edits leave it untouched. The trigger skips the 'update' enqueue
-- when this column's value changed in the same UPDATE.
ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS notion_optout_marker TEXT;


-- ----------------------------------------------------------------------------
-- 2) The trigger function.
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER so it can always write `notion_sync_queue` and read
-- `user_notion_settings` regardless of the caller's RLS context. It only ever
-- touches rows belonging to the triggering highlight's own user_id, so this
-- grants no cross-user access.
CREATE OR REPLACE FUNCTION enqueue_notion_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid;
  v_notion_on   boolean;
  v_existing_id uuid;
  v_pending_add uuid;
BEGIN
  -- Owning user: NEW for INSERT/UPDATE, OLD for DELETE.
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  -- Gate: only enqueue when this user has Notion sync enabled. Mirrors the
  -- "Notion integration not configured" early-return in /api/notion/queue.
  SELECT TRUE INTO v_notion_on
  FROM user_notion_settings
  WHERE user_id = v_user_id AND enabled = TRUE
  LIMIT 1;

  IF v_notion_on IS NOT TRUE THEN
    RETURN NULL;  -- AFTER trigger: the return value is ignored anyway.
  END IF;

  -- ---- INSERT -> 'add' -----------------------------------------------------
  IF TG_OP = 'INSERT' THEN
    -- Highlights imported from Notion are already on the page; never echo back.
    IF NEW.imported_from_notion THEN
      RETURN NULL;
    END IF;

    INSERT INTO notion_sync_queue
      (user_id, highlight_id, operation_type, text, html_content,
       status, retry_count, max_retries)
    VALUES
      (NEW.user_id, NEW.id, 'add', NEW.text, NEW.html_content,
       'pending', 0, 5);

    RETURN NULL;
  END IF;

  -- ---- UPDATE -> 'update' --------------------------------------------------
  -- The trigger's WHEN clause guarantees text/html_content actually changed,
  -- so rating / resurface / archive updates never reach this branch.
  IF TG_OP = 'UPDATE' THEN
    -- "Don't sync to Notion": if this edit bumped the opt-out marker, the user
    -- explicitly chose to keep this change local. Enqueue nothing.
    IF NEW.notion_optout_marker IS DISTINCT FROM OLD.notion_optout_marker THEN
      RETURN NULL;
    END IF;

    -- De-dupe: fold into an existing un-synced pending 'update' so rapid edits
    -- collapse to a single queue row (newest content wins). original_text /
    -- original_html_content are deliberately left untouched — they must keep
    -- pointing at the content currently in Notion. If the existing entry is
    -- already 'processing', it is left alone and a fresh row is inserted so
    -- the newer edit is not lost (same as the old queue API).
    SELECT id INTO v_existing_id
    FROM notion_sync_queue
    WHERE user_id        = NEW.user_id
      AND highlight_id   = NEW.id
      AND operation_type = 'update'
      AND status         = 'pending'
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE notion_sync_queue
      SET text         = NEW.text,
          html_content = NEW.html_content
      WHERE id = v_existing_id;
    ELSE
      INSERT INTO notion_sync_queue
        (user_id, highlight_id, operation_type, text, html_content,
         original_text, original_html_content,
         status, retry_count, max_retries)
      VALUES
        (NEW.user_id, NEW.id, 'update', NEW.text, NEW.html_content,
         OLD.text, OLD.html_content,
         'pending', 0, 5);
    END IF;

    RETURN NULL;
  END IF;

  -- ---- DELETE -> 'delete' (or cancel a never-synced 'add') -----------------
  IF TG_OP = 'DELETE' THEN
    -- Delete-after-add short-circuit: if the highlight's 'add' never made it
    -- to Notion, there is nothing there to delete. Cancel the un-started
    -- pending add (and any un-started pending updates) and enqueue nothing.
    SELECT id INTO v_pending_add
    FROM notion_sync_queue
    WHERE user_id        = OLD.user_id
      AND highlight_id   = OLD.id
      AND operation_type = 'add'
      AND status         = 'pending'
      AND retry_count    = 0
    LIMIT 1;

    IF v_pending_add IS NOT NULL THEN
      DELETE FROM notion_sync_queue
      WHERE user_id        = OLD.user_id
        AND highlight_id   = OLD.id
        AND operation_type IN ('add', 'update')
        AND status         = 'pending'
        AND retry_count    = 0;

      RETURN NULL;
    END IF;

    -- highlight_id is left NULL: the highlights row is gone, and the delete is
    -- matched against Notion by its text/html content at sync time.
    INSERT INTO notion_sync_queue
      (user_id, highlight_id, operation_type, text, html_content,
       status, retry_count, max_retries)
    VALUES
      (OLD.user_id, NULL, 'delete', OLD.text, OLD.html_content,
       'pending', 0, 5);

    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$$;


-- ----------------------------------------------------------------------------
-- 3) Wire up the triggers — one per operation.
-- ----------------------------------------------------------------------------
-- AFTER, so the highlight row change is already validated/applied within this
-- transaction. The UPDATE trigger fires ONLY when the synced content actually
-- changed, so review ratings, resurface counts and archive toggles never
-- enqueue a spurious 'update'.
DROP TRIGGER IF EXISTS enqueue_notion_sync_insert ON highlights;
CREATE TRIGGER enqueue_notion_sync_insert
  AFTER INSERT ON highlights
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_notion_sync();

DROP TRIGGER IF EXISTS enqueue_notion_sync_update ON highlights;
CREATE TRIGGER enqueue_notion_sync_update
  AFTER UPDATE ON highlights
  FOR EACH ROW
  WHEN (OLD.text IS DISTINCT FROM NEW.text
        OR OLD.html_content IS DISTINCT FROM NEW.html_content)
  EXECUTE FUNCTION enqueue_notion_sync();

DROP TRIGGER IF EXISTS enqueue_notion_sync_delete ON highlights;
CREATE TRIGGER enqueue_notion_sync_delete
  AFTER DELETE ON highlights
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_notion_sync();

-- ============================================================================
-- Migration complete.
-- The `highlights` table and `notion_sync_queue` are now kept consistent at the
-- database level: a highlight change and its queue row share one transaction.
-- ============================================================================
