-- ============================================================================
-- MIGRATION: Change rating from TEXT to INTEGER (1-5 scale)
-- ============================================================================
-- This migration changes the rating column from TEXT ('low', 'med', 'high')
-- to INTEGER (1-5 scale: low=1, med=3, high=5)
-- ============================================================================

-- Step 1: Add a new temporary column for integer ratings
ALTER TABLE daily_summary_highlights 
ADD COLUMN IF NOT EXISTS rating_int INTEGER CHECK (rating_int >= 1 AND rating_int <= 5);

-- Step 2: Migrate existing data (convert old ratings to new scale)
UPDATE daily_summary_highlights
SET rating_int = CASE
  WHEN rating = 'low' THEN 1
  WHEN rating = 'med' THEN 3
  WHEN rating = 'high' THEN 5
  ELSE NULL
END
WHERE rating IS NOT NULL;

-- Step 3: Drop the old rating column
ALTER TABLE daily_summary_highlights DROP COLUMN IF EXISTS rating;

-- Step 4: Rename the new column to 'rating'
ALTER TABLE daily_summary_highlights RENAME COLUMN rating_int TO rating;

-- Step 5: Update highlights table average_rating calculation
-- Note: This will need to be recalculated in the application code
-- The average_rating column can stay as DECIMAL(3,2) but will now represent 1-5 scale

