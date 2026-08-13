-- Migration: Stamp when a daily_summary_highlights rating was given
--
-- Offline devices can each rate the same appearance and then sync. The app
-- keeps the earlier tap by writing `rated_at` and UPDATE … WHERE rated_at is
-- null/later. Existing rated rows stay as-is (rated_at NULL): a later replay
-- will not overwrite them, because the conflict filter also allows writes
-- only when rating IS NULL or rated_at is strictly later than the incoming tap.

ALTER TABLE daily_summary_highlights
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_daily_summary_highlights_rated_at
  ON daily_summary_highlights (rated_at);
