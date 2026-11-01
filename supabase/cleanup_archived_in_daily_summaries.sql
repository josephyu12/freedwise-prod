-- Cleanup: remove archived highlights' UNRATED assignments from today's and
-- future daily_summary_highlights rows.
--
-- Context: archiving is supposed to make a highlight disappear from every day
-- it hasn't been rated on yet. Two generations of app code left rows behind:
--   1. Early on, manual archive only removed FUTURE days (date > today), so
--      today's assignment kept showing until the day rolled over.
--   2. Until Nov 2026 the two-Lows AUTO-archive removed nothing at all — it only
--      set highlights.archived. The reads hid those rows, but they stayed in
--      the table (and still weighed on redistribute's per-day load).
-- The application code now handles both (lib/removeFromFutureMonths.ts, called
-- by every archive path including lib/highlightStats.ts), but rows already in
-- the table need this one-time sweep.
--
-- RATED rows are kept, on any day — they are review history and the day view
-- shows them badged "Archived" (lib/monthReviewStatus.ts isVisibleAssignment).
-- Past unrated rows are left alone too: they never surface again and the
-- visibility rule hides them.
--
-- Safe to re-run.

DELETE FROM daily_summary_highlights dsh
USING highlights h, daily_summaries ds
WHERE dsh.highlight_id = h.id
  AND dsh.daily_summary_id = ds.id
  AND h.archived = true
  AND dsh.rating IS NULL
  AND ds.date >= CURRENT_DATE;
