-- ============================================================================
-- MIGRATION: Widget token revocation (user_widget_settings.token_version)
-- ============================================================================
-- Widget tokens are stateless HMACs, so without server-side state they cannot
-- be revoked before their 90-day expiry. Each token now embeds the user's
-- token_version at signing time (lib/widgetToken.ts), and /api/review/widget
-- rejects any token whose version isn't current. DELETE /api/widget-token
-- bumps the version, instantly invalidating every previously issued token —
-- including legacy version-less tokens, which count as version 1.
--
-- Idempotent — safe to run more than once.
-- Date: 2026-07-09
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_widget_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE user_widget_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own widget settings" ON user_widget_settings;
CREATE POLICY "Users can view their own widget settings" ON user_widget_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own widget settings" ON user_widget_settings;
CREATE POLICY "Users can insert their own widget settings" ON user_widget_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own widget settings" ON user_widget_settings;
CREATE POLICY "Users can update their own widget settings" ON user_widget_settings
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION update_user_widget_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_widget_settings_updated_at ON user_widget_settings;
CREATE TRIGGER update_user_widget_settings_updated_at
  BEFORE UPDATE ON user_widget_settings
  FOR EACH ROW EXECUTE FUNCTION update_user_widget_settings_updated_at();
