-- Migration: Change daily_summary_highlights.rating from integer to text (low/med/high)
-- Run this in Supabase SQL editor

-- Step 1: Add a temporary text column
ALTER TABLE daily_summary_highlights ADD COLUMN rating_new text;

-- Step 2: Migrate existing integer ratings to text
-- 5 -> 'high', 4 -> 'med', 3/2/1 -> 'low'
UPDATE daily_summary_highlights
SET rating_new = CASE
  WHEN rating::text = '5' THEN 'high'
  WHEN rating::text = '4' THEN 'med'
  WHEN rating::text IN ('3', '2', '1') THEN 'low'
  ELSE NULL
END;

-- Step 3: Drop old column, rename new one
ALTER TABLE daily_summary_highlights DROP COLUMN rating;
ALTER TABLE daily_summary_highlights RENAME COLUMN rating_new TO rating;

-- Step 4: Add CHECK constraint to enforce only valid values
ALTER TABLE daily_summary_highlights
  ADD CONSTRAINT rating_values CHECK (rating IN ('low', 'med', 'high') OR rating IS NULL);

-- Step 5: Recalculate average_rating for all highlights using new mapping (low=1, med=2, high=3)
UPDATE highlights h
SET
  average_rating = sub.avg_rating,
  rating_count = sub.cnt
FROM (
  SELECT
    dsh.highlight_id,
    AVG(
      CASE dsh.rating
        WHEN 'low' THEN 1
        WHEN 'med' THEN 2
        WHEN 'high' THEN 3
      END
    ) AS avg_rating,
    COUNT(dsh.rating) AS cnt
  FROM daily_summary_highlights dsh
  WHERE dsh.rating IS NOT NULL
  GROUP BY dsh.highlight_id
) sub
WHERE h.id = sub.highlight_id;

-- Step 6: Auto-archive highlights that have been rated 'low' 2+ times
UPDATE highlights h
SET archived = true
FROM (
  SELECT highlight_id
  FROM daily_summary_highlights
  WHERE rating = 'low'
  GROUP BY highlight_id
  HAVING COUNT(*) >= 2
) low_counts
WHERE h.id = low_counts.highlight_id;
