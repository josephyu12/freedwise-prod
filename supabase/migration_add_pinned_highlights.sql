-- ============================================================================
-- MIGRATION: Add pinned_highlights table
-- ============================================================================
-- This migration adds a table to track pinned highlights (max 10 per user)
-- ============================================================================

-- Create pinned_highlights table
CREATE TABLE IF NOT EXISTS pinned_highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  pinned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, highlight_id)
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_pinned_highlights_user ON pinned_highlights(user_id);
CREATE INDEX IF NOT EXISTS idx_pinned_highlights_highlight ON pinned_highlights(highlight_id);

-- Enable Row Level Security
ALTER TABLE pinned_highlights ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see their own pinned highlights
CREATE POLICY "Users can view their own pinned highlights"
  ON pinned_highlights
  FOR SELECT
  USING (auth.uid() = user_id);

-- RLS Policy: Users can insert their own pinned highlights
CREATE POLICY "Users can insert their own pinned highlights"
  ON pinned_highlights
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policy: Users can delete their own pinned highlights
CREATE POLICY "Users can delete their own pinned highlights"
  ON pinned_highlights
  FOR DELETE
  USING (auth.uid() = user_id);

-- Function to enforce 10-pin limit (called via trigger)
CREATE OR REPLACE FUNCTION enforce_pin_limit()
RETURNS TRIGGER AS $$
DECLARE
  pin_count INTEGER;
BEGIN
  -- Count current pins for this user
  SELECT COUNT(*) INTO pin_count
  FROM pinned_highlights
  WHERE user_id = NEW.user_id;

  -- If already at limit, raise error
  IF pin_count >= 10 THEN
    RAISE EXCEPTION 'Maximum of 10 pinned highlights allowed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to enforce limit before insert
CREATE TRIGGER check_pin_limit
  BEFORE INSERT ON pinned_highlights
  FOR EACH ROW
  EXECUTE FUNCTION enforce_pin_limit();

