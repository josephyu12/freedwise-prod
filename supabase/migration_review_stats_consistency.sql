-- Keep stored review counts correct after clearing ratings / resetting a cycle.
-- Requires the current text rating schema and highlight_months_reviewed.
-- This migration preserves ratings, assignments, ledger rows, and archive flags.
BEGIN;

CREATE OR REPLACE FUNCTION update_resurface_count_from_hmr()
RETURNS TRIGGER AS $$
BEGIN
  -- DELETE has no NEW row. UPDATE may move the ledger row to another highlight.
  IF TG_OP <> 'INSERT' THEN
    UPDATE highlights SET resurface_count = (
      SELECT COUNT(*) FROM highlight_months_reviewed WHERE highlight_id = OLD.highlight_id
    ) WHERE id = OLD.highlight_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE highlights SET resurface_count = (
      SELECT COUNT(*) FROM highlight_months_reviewed WHERE highlight_id = NEW.highlight_id
    ) WHERE id = NEW.highlight_id;
  END IF;
  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_resurface_count_on_hmr ON highlight_months_reviewed;
CREATE TRIGGER trigger_resurface_count_on_hmr
AFTER INSERT OR UPDATE OR DELETE ON highlight_months_reviewed
FOR EACH ROW EXECUTE FUNCTION update_resurface_count_from_hmr();

-- Rating helpers already recalculate after set/clear. Reset removes assignment
-- rows directly (including via summary cascade), so cover deletion in SQL too.
CREATE OR REPLACE FUNCTION update_rating_stats_after_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.rating IS NOT NULL THEN
    UPDATE highlights SET
      average_rating = stats.average,
      rating_count = stats.total
    FROM (
      SELECT COALESCE(AVG(CASE rating WHEN 'low' THEN 1 WHEN 'med' THEN 2 WHEN 'high' THEN 3 END), 0) AS average,
             COUNT(rating) AS total
      FROM daily_summary_highlights WHERE highlight_id = OLD.highlight_id
    ) stats
    WHERE highlights.id = OLD.highlight_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_rating_stats_after_delete ON daily_summary_highlights;
CREATE TRIGGER trigger_rating_stats_after_delete
AFTER DELETE ON daily_summary_highlights
FOR EACH ROW EXECUTE FUNCTION update_rating_stats_after_delete();

-- Repair stale stored totals, including highlights whose last rating/ledger was
-- deleted. Use a LEFT JOIN so those highlights get zero instead of being skipped.
WITH stats AS (
  SELECT h.id,
         COALESCE(AVG(CASE d.rating WHEN 'low' THEN 1 WHEN 'med' THEN 2 WHEN 'high' THEN 3 END), 0) AS average,
         COUNT(d.rating) AS total,
         (SELECT COUNT(*) FROM highlight_months_reviewed m WHERE m.highlight_id = h.id) AS cycles
  FROM highlights h
  LEFT JOIN daily_summary_highlights d ON d.highlight_id = h.id
  GROUP BY h.id
)
UPDATE highlights h SET average_rating = s.average, rating_count = s.total, resurface_count = s.cycles
FROM stats s
WHERE h.id = s.id
  AND (h.average_rating IS DISTINCT FROM s.average
    OR h.rating_count IS DISTINCT FROM s.total
    OR h.resurface_count IS DISTINCT FROM s.cycles);

COMMIT;
