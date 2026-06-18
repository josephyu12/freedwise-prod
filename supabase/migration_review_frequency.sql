-- Migration: per-user review frequency (monthly / bimonthly / quarterly / … / yearly)
--            + an on/off switch for daily review.
--
-- Adds the user_review_settings table. The existing
-- highlight_months_reviewed.month_year column is REINTERPRETED as a generic
-- "cycle key" (the cycle's start month, YYYY-MM). For frequency_months = 1 (the
-- default) the cycle key IS the calendar month, so all existing rows remain
-- valid and NO data migration is required.
--
-- Defaults are load-bearing: a user with no row reads as monthly + enabled, so
-- existing users are completely unaffected until they opt in.
--
-- Idempotent and RLS-correct (follows the conventions in MIGRATIONS.md).
-- Date: 2026-06-18

CREATE TABLE IF NOT EXISTS user_review_settings (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  frequency_months     INTEGER NOT NULL DEFAULT 1
                       CHECK (frequency_months >= 1 AND frequency_months <= 12),
  daily_review_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- If the table predates this column (shipped frequency first), add it idempotently:
ALTER TABLE user_review_settings
  ADD COLUMN IF NOT EXISTS daily_review_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE user_review_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own review settings" ON user_review_settings;
CREATE POLICY "Users can view their own review settings" ON user_review_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own review settings" ON user_review_settings;
CREATE POLICY "Users can insert their own review settings" ON user_review_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own review settings" ON user_review_settings;
CREATE POLICY "Users can update their own review settings" ON user_review_settings
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own review settings" ON user_review_settings;
CREATE POLICY "Users can delete their own review settings" ON user_review_settings
  FOR DELETE USING (auth.uid() = user_id);

-- Keep updated_at fresh on every UPDATE.
CREATE OR REPLACE FUNCTION update_user_review_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_review_settings_updated_at ON user_review_settings;
CREATE TRIGGER update_user_review_settings_updated_at
  BEFORE UPDATE ON user_review_settings
  FOR EACH ROW EXECUTE FUNCTION update_user_review_settings_updated_at();
