-- Fix corrupted review status data
-- This script removes incorrect entries from highlight_months_reviewed
-- and only keeps entries for highlights that have actually been rated

-- First, let's see what we're working with
-- Get current month
DO $$
DECLARE
    current_month TEXT;
    deleted_count INTEGER;
BEGIN
    -- Get current month in YYYY-MM format
    current_month := TO_CHAR(CURRENT_DATE, 'YYYY-MM');
    
    -- Delete all entries for the current month that don't have actual ratings
    -- A highlight should only be marked as reviewed if it has a rating in daily_summary_highlights
    DELETE FROM highlight_months_reviewed
    WHERE month_year = current_month
    AND highlight_id NOT IN (
        SELECT DISTINCT dsh.highlight_id
        FROM daily_summary_highlights dsh
        INNER JOIN daily_summaries ds ON dsh.daily_summary_id = ds.id
        WHERE ds.date >= DATE_TRUNC('month', CURRENT_DATE)
        AND ds.date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
        AND dsh.rating IS NOT NULL
    );
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RAISE NOTICE 'Deleted % incorrect review status entries for month %', deleted_count, current_month;
END $$;

-- Now, insert correct entries for highlights that have been rated but aren't in highlight_months_reviewed
INSERT INTO highlight_months_reviewed (highlight_id, month_year)
SELECT DISTINCT dsh.highlight_id, TO_CHAR(ds.date, 'YYYY-MM')
FROM daily_summary_highlights dsh
INNER JOIN daily_summaries ds ON dsh.daily_summary_id = ds.id
WHERE ds.date >= DATE_TRUNC('month', CURRENT_DATE)
AND ds.date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
AND dsh.rating IS NOT NULL
AND NOT EXISTS (
    SELECT 1
    FROM highlight_months_reviewed hmr
    WHERE hmr.highlight_id = dsh.highlight_id
    AND hmr.month_year = TO_CHAR(ds.date, 'YYYY-MM')
)
ON CONFLICT (highlight_id, month_year) DO NOTHING;

