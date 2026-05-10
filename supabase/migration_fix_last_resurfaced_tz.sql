-- Migration: correct last_resurfaced values backfilled by migration_resurface_stats.sql.
--
-- Bug: the original backfill used `MAX(ds.date)::timestamptz`, which casts a DATE
-- to midnight UTC. In any negative-offset local timezone (ET, CT, MT, PT, ...),
-- midnight UTC renders as the *previous* calendar day via `toLocaleDateString()`.
-- Example: a highlight last reviewed on 2026-04-12 was stored as
-- `2026-04-12 00:00:00+00`, which renders as "4/11" in ET.
--
-- Fix: re-run the backfill anchored at noon UTC, which falls within the same
-- calendar day in every Americas/EU/most-Asia timezone.
--
-- Idempotent. Only touches highlights whose last_resurfaced is currently at the
-- midnight-UTC boundary (i.e. clearly came from the bad cast).

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
WHERE h.id = stats.highlight_id
  AND h.last_resurfaced IS NOT NULL
  AND EXTRACT(HOUR FROM h.last_resurfaced AT TIME ZONE 'UTC') = 0
  AND EXTRACT(MINUTE FROM h.last_resurfaced AT TIME ZONE 'UTC') = 0
  AND EXTRACT(SECOND FROM h.last_resurfaced AT TIME ZONE 'UTC') = 0;
