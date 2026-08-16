-- ============================================================================
-- MIGRATION: Coalesce multiple edits of the same highlight into one Notion push
-- ============================================================================
-- Date: 2026-08-16
-- Idempotent — safe to run more than once.
-- Replaces the enqueue_notion_sync() function from
-- migration_notion_sync_trigger.sql. The triggers themselves are unchanged.
--
-- THE PROBLEM THIS FIXES
--   The old UPDATE branch only folded an edit into an existing *pending
--   'update'* row. Two common situations still produced one Notion round trip
--   PER EDIT (delete the highlight's blocks, recreate them, then do the whole
--   thing again for the next edit) instead of a single push of the final
--   content:
--
--   1. Editing a highlight whose 'add' hasn't synced yet: the add pushed the
--      stale original content, then a separate 'update' round trip immediately
--      rewrote the same blocks.
--   2. Editing a highlight whose previous 'update' had FAILED: a brand-new
--      'update' row was inserted whose original_text = the previous edit's
--      content — which never reached Notion. That row could never match the
--      page, so it failed too, and its retry fallback re-appended the
--      highlight, leaving the stale block AND a duplicate.
--
-- THE FIX (UPDATE branch, in priority order)
--   1. Fold into an existing pending 'update' (unchanged behaviour): newest
--      content wins, original_* keep pointing at what is actually in Notion.
--   2. Fold into a fresh pending 'add' (retry_count = 0): the highlight isn't
--      on the page yet, so the add itself just carries the newest content and
--      no 'update' row is needed at all. Retried adds are excluded because a
--      prior attempt may have partially committed the OLD content, and retry
--      recovery searches the page for the row's content — swapping the
--      content would hide those partial leftovers.
--   3. Resurrect the newest 'failed' update instead of inserting a fresh row:
--      set the new content, keep original_* (they still describe the page),
--      and reset status/retry_count so the user's new edit gets a fresh
--      attempt cycle.
--   4. Only when an update is mid-flight ('processing') — or no foldable row
--      exists — insert a fresh row, exactly as before.
--
--   The companion change in POST /api/notion/sync closes the remaining
--   mid-flight window: after a successful update push (which always re-reads
--   the highlight's latest content from the DB), sibling pending/failed
--   'update' rows for the same highlight that pre-date that read are marked
--   completed instead of each redoing the same delete-and-recreate.
-- ============================================================================

CREATE OR REPLACE FUNCTION enqueue_notion_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id       uuid;
  v_notion_on     boolean;
  v_existing_id   uuid;
  v_pending_add   uuid;
  v_failed_update uuid;
BEGIN
  -- Owning user: NEW for INSERT/UPDATE, OLD for DELETE.
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  -- Gate: only enqueue when this user has Notion sync enabled.
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

    -- (1) Fold into an existing un-synced pending 'update' so rapid edits
    -- collapse to a single queue row (newest content wins). original_text /
    -- original_html_content are deliberately left untouched — they must keep
    -- pointing at the content currently in Notion.
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

      RETURN NULL;
    END IF;

    -- (2) Fold into a fresh pending 'add' that hasn't started syncing: the
    -- highlight isn't on the Notion page yet, so the add can simply carry the
    -- newest content — no separate 'update' round trip is needed at all.
    -- Retried adds (retry_count > 0) are excluded: a prior attempt may have
    -- partially committed the OLD content, and retry recovery searches the
    -- page for the row's content, so swapping it would hide those leftovers.
    SELECT id INTO v_pending_add
    FROM notion_sync_queue
    WHERE user_id        = NEW.user_id
      AND highlight_id   = NEW.id
      AND operation_type = 'add'
      AND status         = 'pending'
      AND retry_count    = 0
    LIMIT 1;

    IF v_pending_add IS NOT NULL THEN
      UPDATE notion_sync_queue
      SET text         = NEW.text,
          html_content = NEW.html_content
      WHERE id = v_pending_add;

      RETURN NULL;
    END IF;

    -- (3) Resurrect the newest 'failed' update instead of inserting a fresh
    -- row. The failed row's original_* still describe what is actually on the
    -- Notion page; a fresh row would carry original = OLD (this edit's
    -- predecessor), which never reached Notion, so it could never match the
    -- page and its retry fallback would append a duplicate. The new edit
    -- grants a fresh attempt cycle.
    SELECT id INTO v_failed_update
    FROM notion_sync_queue
    WHERE user_id        = NEW.user_id
      AND highlight_id   = NEW.id
      AND operation_type = 'update'
      AND status         = 'failed'
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_failed_update IS NOT NULL THEN
      UPDATE notion_sync_queue
      SET text          = NEW.text,
          html_content  = NEW.html_content,
          status        = 'pending',
          retry_count   = 0,
          next_retry_at = NULL,
          error_message = NULL
      WHERE id = v_failed_update;

      RETURN NULL;
    END IF;

    -- (4) Nothing foldable (e.g. the only sibling row is mid-flight
    -- 'processing'): insert a fresh row so the newer edit is not lost.
    INSERT INTO notion_sync_queue
      (user_id, highlight_id, operation_type, text, html_content,
       original_text, original_html_content,
       status, retry_count, max_retries)
    VALUES
      (NEW.user_id, NEW.id, 'update', NEW.text, NEW.html_content,
       OLD.text, OLD.html_content,
       'pending', 0, 5);

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

-- ============================================================================
-- Migration complete. The triggers created by migration_notion_sync_trigger.sql
-- still point at enqueue_notion_sync(); CREATE OR REPLACE swaps the body in
-- place, so no trigger changes are needed.
-- ============================================================================
