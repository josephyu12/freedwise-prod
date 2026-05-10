-- Migration: keep highlights.resurface_count and highlights.last_resurfaced in sync.
--
-- Semantics (per product decision):
--   resurface_count = number of distinct months the highlight has been rated in
--   last_resurfaced = most recent timestamp a rating was set on the highlight
--
-- Two triggers cover all rating paths (daily page, review page, offline sync, future paths):
--   1. AFTER INSERT/UPDATE on highlight_months_reviewed -> recompute resurface_count
--   2. AFTER INSERT/UPDATE OF rating on daily_summary_highlights -> bump last_resurfaced
--
-- A one-time backfill at the bottom fixes the historical data, since these fields
-- were never written by application code prior to this migration.

-- ---------------------------------------------------------------------------
-- 1. Trigger: keep resurface_count = COUNT(DISTINCT month_year) per highlight.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_resurface_count_from_hmr()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE highlights
  SET resurface_count = (
    SELECT COUNT(*)
    FROM highlight_months_reviewed
    WHERE highlight_id = NEW.highlight_id
  )
  WHERE id = NEW.highlight_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_resurface_count_on_hmr ON highlight_months_reviewed;
CREATE TRIGGER trigger_resurface_count_on_hmr
AFTER INSERT OR UPDATE ON highlight_months_reviewed
FOR EACH ROW
EXECUTE FUNCTION update_resurface_count_from_hmr();

-- ---------------------------------------------------------------------------
-- 2. Trigger: bump last_resurfaced whenever a rating is set on an assignment.
--    Fires for re-rates within the same month (HMR upsert wouldn't catch those).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bump_last_resurfaced_on_rating()
RETURNS TRIGGER AS $$
BEGIN
  -- No-op when clearing the rating
  IF NEW.rating IS NULL THEN
    RETURN NEW;
  END IF;
  -- No-op when rating is unchanged
  IF TG_OP = 'UPDATE' AND OLD.rating IS NOT DISTINCT FROM NEW.rating THEN
    RETURN NEW;
  END IF;
  UPDATE highlights
  SET last_resurfaced = NOW()
  WHERE id = NEW.highlight_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_bump_last_resurfaced_on_rating ON daily_summary_highlights;
CREATE TRIGGER trigger_bump_last_resurfaced_on_rating
AFTER INSERT OR UPDATE OF rating ON daily_summary_highlights
FOR EACH ROW
EXECUTE FUNCTION bump_last_resurfaced_on_rating();

-- ---------------------------------------------------------------------------
-- 3. One-time backfill of resurface_count.
--    Uses the union of highlight_months_reviewed AND rated daily_assignments,
--    so it is correct even if the HMR backfill from the prior step hasn't run.
-- ---------------------------------------------------------------------------
UPDATE highlights h
SET resurface_count = COALESCE(stats.cnt, 0)
FROM (
  SELECT highlight_id, COUNT(DISTINCT month_year) AS cnt
  FROM (
    SELECT highlight_id, month_year FROM highlight_months_reviewed
    UNION
    SELECT dsh.highlight_id, to_char(ds.date, 'YYYY-MM') AS month_year
    FROM daily_summary_highlights dsh
    JOIN daily_summaries ds ON ds.id = dsh.daily_summary_id
    WHERE dsh.rating IS NOT NULL
  ) all_months
  GROUP BY highlight_id
) stats
WHERE h.id = stats.highlight_id;

-- ---------------------------------------------------------------------------
-- 4. One-time backfill of last_resurfaced from the most recent rated assignment.
--    Anchor at noon UTC so the local-time render lands on the right calendar day
--    (a bare ds.date::timestamptz = midnight UTC, which shifts to the prior day
--    in any negative-offset timezone like ET).
-- ---------------------------------------------------------------------------
UPDATE highlights h
SET last_resurfaced = stats.last_rated
FROM (
  SELECT dsh.highlight_id,
         (MAX(ds.date)::timestamp + interval '12 hours') AT TIME ZONE 'UTC' AS last_rated
  FROM daily_summary_highlights dsh
  JOIN daily_summaries ds ON ds.id = dsh.daily_summary_id
  WHERE dsh.rating IS NOT NULL
  GROUP BY dsh.highlight_id
) stats
WHERE h.id = stats.highlight_id;
