-- One-time cleanup: remove archived highlights from today's and future
-- daily_summary_highlights assignments.
--
-- Context: Previously, archiving a highlight only removed it from FUTURE daily
-- summaries (date > today). Today's assignment was left intact, so the
-- archived highlight kept appearing in /review and /daily until the day rolled
-- over. The application code is now fixed (removeFromFutureMonths uses
-- `>= today` and review queries filter `archived = false`), but rows already
-- in the table need to be cleaned up.
--
-- Past summaries are intentionally left alone — they represent historical
-- review records.
--
-- Safe to re-run.

DELETE FROM daily_summary_highlights dsh
USING highlights h, daily_summaries ds
WHERE dsh.highlight_id = h.id
  AND dsh.daily_summary_id = ds.id
  AND h.archived = true
  AND ds.date >= CURRENT_DATE;
