-- ============================================================================
-- MIGRATION: Add review_ahead_order table
-- ============================================================================
-- Server-side home for the frozen review-ahead sequence (see lib/aheadOrder.ts).
-- Previously the sequence lived only in localStorage, so each device computed
-- and froze its own order — switching devices teleported the resume point.
-- One row per user per cycle; `ids` is the ordered highlight_id sequence.
-- ============================================================================

CREATE TABLE IF NOT EXISTS review_ahead_order (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cycle_key TEXT NOT NULL,
  ids JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (user_id, cycle_key)
);

-- Enable Row Level Security
ALTER TABLE review_ahead_order ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see their own ahead order
CREATE POLICY "Users can view their own ahead order"
  ON review_ahead_order
  FOR SELECT
  USING (auth.uid() = user_id);

-- RLS Policy: Users can insert their own ahead order
CREATE POLICY "Users can insert their own ahead order"
  ON review_ahead_order
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policy: Users can update their own ahead order
CREATE POLICY "Users can update their own ahead order"
  ON review_ahead_order
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- RLS Policy: Users can delete their own ahead order
CREATE POLICY "Users can delete their own ahead order"
  ON review_ahead_order
  FOR DELETE
  USING (auth.uid() = user_id);
