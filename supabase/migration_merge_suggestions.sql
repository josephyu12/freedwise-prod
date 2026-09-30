-- ============================================================================
-- MIGRATION: Near-duplicate detection + merge for highlights (/merge page)
-- ============================================================================
-- Date: 2026-09-29
-- Idempotent — safe to run more than once.
-- Requires: migration_add_embeddings.sql (pgvector + highlights.embedding).
--
-- WHY
--   Exact duplicates are already impossible (unique (user_id, text_hash)),
--   but the same idea written twice in slightly different words slips
--   through. This adds:
--
--   1. near_duplicate_pairs(min_similarity, per_highlight)
--        Every pair of the caller's active highlights whose embeddings sit at
--        or above the cosine floor, minus pairs the user has already said
--        "keep both" to. One HNSW probe per highlight (LATERAL top-k), so it
--        scales as n·log n rather than the n² of a full self-join.
--
--   2. highlight_merge_dismissals
--        "Keep both" decisions, so a pair the user has consciously kept apart
--        stops being suggested. Canonical ordering (a < b) keeps one row per
--        pair. Rows cascade away with either highlight.
--
--   3. merge_highlights(p_keep, p_remove, p_text, p_html)
--        Transactional merge: the kept highlight takes the user's combined
--        text, inherits the removed one's categories, links and pin, and the
--        removed highlight is deleted. The enqueue_notion_sync trigger sees a
--        normal UPDATE + DELETE, so Notion stays in step. The kept row's
--        embedding_hash no longer matches md5(text), so embedding_pending()
--        re-embeds it lazily on the next page that runs the sync hook.
--        Review history (months reviewed, ratings) is NOT merged — the kept
--        highlight simply keeps its own.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Dismissals ("keep both")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS highlight_merge_dismissals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  highlight_a UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  highlight_b UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, highlight_a, highlight_b),
  -- canonical ordering: one row per unordered pair
  CHECK (highlight_a < highlight_b)
);

CREATE INDEX IF NOT EXISTS idx_highlight_merge_dismissals_user
  ON highlight_merge_dismissals (user_id);

ALTER TABLE highlight_merge_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own merge dismissals" ON highlight_merge_dismissals;
CREATE POLICY "Users can view their own merge dismissals"
  ON highlight_merge_dismissals FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own merge dismissals" ON highlight_merge_dismissals;
CREATE POLICY "Users can insert their own merge dismissals"
  ON highlight_merge_dismissals FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own merge dismissals" ON highlight_merge_dismissals;
CREATE POLICY "Users can delete their own merge dismissals"
  ON highlight_merge_dismissals FOR DELETE
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Candidate pairs
-- ---------------------------------------------------------------------------
-- For each active, embedded highlight of the caller, its `per_highlight`
-- nearest neighbours at or above `min_similarity`. Pairs come back once,
-- canonically ordered (a_id < b_id), strongest first. Dismissed pairs are
-- excluded. `per_highlight` is a per-node cap, not a global one: a highlight
-- with six near-copies still surfaces via the other five's own probes.
CREATE OR REPLACE FUNCTION near_duplicate_pairs(
  min_similarity FLOAT DEFAULT 0.85,
  per_highlight INT DEFAULT 5
)
RETURNS TABLE (a_id UUID, b_id UUID, similarity FLOAT)
LANGUAGE sql
SECURITY INVOKER
STABLE
-- Don't SET hnsw.ef_search here: that GUC is superuser-only on Supabase
-- ("permission denied to set parameter hnsw.ef_search"). Default ef_search
-- (40) is enough for a per-user probe of a few thousand rows.
AS $$
  WITH me AS (SELECT auth.uid() AS uid),
  mine AS (
    SELECT h.id, h.embedding
    FROM highlights h, me
    WHERE h.user_id = me.uid
      AND h.archived = FALSE
      AND h.embedding IS NOT NULL
  ),
  probes AS (
    SELECT src.id AS src_id, n.id AS nbr_id, n.similarity
    FROM mine src
    CROSS JOIN LATERAL (
      SELECT h.id,
             1 - (h.embedding <=> src.embedding) AS similarity
      FROM highlights h, me
      WHERE h.user_id = me.uid
        AND h.archived = FALSE
        AND h.embedding IS NOT NULL
        AND h.id <> src.id
      ORDER BY h.embedding <=> src.embedding
      LIMIT per_highlight
    ) n
    WHERE n.similarity >= min_similarity
  ),
  pairs AS (
    SELECT LEAST(pr.src_id, pr.nbr_id)    AS a_id,
           GREATEST(pr.src_id, pr.nbr_id) AS b_id,
           MAX(pr.similarity)             AS similarity
    FROM probes pr
    GROUP BY 1, 2
  )
  SELECT p.a_id, p.b_id, p.similarity
  FROM pairs p, me
  WHERE NOT EXISTS (
    SELECT 1 FROM highlight_merge_dismissals d
    WHERE d.user_id = me.uid
      AND d.highlight_a = p.a_id
      AND d.highlight_b = p.b_id
  )
  ORDER BY p.similarity DESC;
$$;

-- ---------------------------------------------------------------------------
-- 3. Merge
-- ---------------------------------------------------------------------------
-- Runs as the caller (SECURITY INVOKER), so every statement is still subject
-- to the normal RLS policies; the explicit ownership check up front just
-- turns "silently touched zero rows" into a clear error.
CREATE OR REPLACE FUNCTION merge_highlights(
  p_keep   UUID,
  p_remove UUID,
  p_text   TEXT,
  p_html   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_owned INT;
  v_removed_pinned_at TIMESTAMPTZ;
BEGIN
  IF p_keep IS NULL OR p_remove IS NULL OR p_keep = p_remove THEN
    RAISE EXCEPTION 'merge_highlights: need two distinct highlights';
  END IF;
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RAISE EXCEPTION 'merge_highlights: merged text cannot be empty';
  END IF;

  SELECT COUNT(*) INTO v_owned
  FROM highlights
  WHERE id IN (p_keep, p_remove) AND user_id = v_uid;
  IF v_owned <> 2 THEN
    RAISE EXCEPTION 'merge_highlights: highlight not found';
  END IF;

  -- Categories: union of both sets onto the kept highlight.
  INSERT INTO highlight_categories (highlight_id, category_id)
  SELECT p_keep, hc.category_id
  FROM highlight_categories hc
  WHERE hc.highlight_id = p_remove
  ON CONFLICT (highlight_id, category_id) DO NOTHING;

  -- Links: every highlight linked to the removed one becomes linked to the
  -- kept one (canonical from < to ordering, see lib/highlightLinks.ts). A
  -- link between the two being merged simply disappears with the delete.
  INSERT INTO highlight_links (from_highlight_id, to_highlight_id, link_text)
  SELECT LEAST(p_keep, other.id), GREATEST(p_keep, other.id), other.link_text
  FROM (
    SELECT CASE WHEN l.from_highlight_id = p_remove THEN l.to_highlight_id
                ELSE l.from_highlight_id END AS id,
           l.link_text
    FROM highlight_links l
    WHERE l.from_highlight_id = p_remove OR l.to_highlight_id = p_remove
  ) other
  WHERE other.id <> p_keep
  ON CONFLICT (from_highlight_id, to_highlight_id) DO NOTHING;

  -- Pin: if only the removed highlight was pinned, the kept one takes its
  -- place. Delete first so the 10-pin BEFORE INSERT trigger doesn't count
  -- the pin we are about to move.
  SELECT pinned_at INTO v_removed_pinned_at
  FROM pinned_highlights
  WHERE user_id = v_uid AND highlight_id = p_remove;
  IF v_removed_pinned_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pinned_highlights WHERE user_id = v_uid AND highlight_id = p_keep
  ) THEN
    DELETE FROM pinned_highlights WHERE user_id = v_uid AND highlight_id = p_remove;
    INSERT INTO pinned_highlights (user_id, highlight_id, pinned_at)
    VALUES (v_uid, p_keep, v_removed_pinned_at);
  END IF;

  -- Delete the removed highlight FIRST: if the merged text happens to
  -- normalise to the removed highlight's own text, updating the kept row
  -- before the delete would trip the (user_id, text_hash) unique constraint.
  -- FK cascades clean up its categories, links, months, ratings, pin and
  -- dismissals; the Notion trigger enqueues the delete.
  DELETE FROM highlights WHERE id = p_remove AND user_id = v_uid;

  UPDATE highlights
  SET text = p_text,
      html_content = NULLIF(p_html, '')
  WHERE id = p_keep AND user_id = v_uid;
END;
$$;

-- ============================================================================
-- Migration complete.
-- ============================================================================
