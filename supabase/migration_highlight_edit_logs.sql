-- ============================================================================
-- MIGRATION: highlight_edit_logs
-- ============================================================================
-- Keep a full history of text/html edits so Recently Edited can show every
-- change, not only the latest snapshot on the highlight row.
--
-- Retention: rows older than 90 days are deleted. Cleanup runs whenever a
-- new edit is logged (see log_highlight_edit). This is a time-based purge,
-- not a per-highlight cap — a highlight edited often still keeps every
-- edit from the last 90 days.
-- ============================================================================

CREATE TABLE IF NOT EXISTS highlight_edit_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  previous_text TEXT,
  previous_html_content TEXT,
  new_text TEXT,
  new_html_content TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_highlight_edit_logs_user_created
  ON highlight_edit_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_highlight_edit_logs_highlight
  ON highlight_edit_logs(highlight_id, created_at DESC);

ALTER TABLE highlight_edit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own highlight edit logs" ON highlight_edit_logs;
CREATE POLICY "Users can view their own highlight edit logs"
  ON highlight_edit_logs
  FOR SELECT
  USING (auth.uid() = user_id);

-- Inserts come from the trigger (SECURITY DEFINER), not the client.
CREATE OR REPLACE FUNCTION log_highlight_edit()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.text IS DISTINCT FROM NEW.text
     OR OLD.html_content IS DISTINCT FROM NEW.html_content THEN
    INSERT INTO highlight_edit_logs (
      highlight_id,
      user_id,
      previous_text,
      previous_html_content,
      new_text,
      new_html_content
    ) VALUES (
      NEW.id,
      NEW.user_id,
      OLD.text,
      OLD.html_content,
      NEW.text,
      NEW.html_content
    );

    -- Drop this user's logs older than 90 days. Uses idx_highlight_edit_logs_user_created.
    DELETE FROM highlight_edit_logs
    WHERE user_id = NEW.user_id
      AND created_at < NOW() - INTERVAL '90 days';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_log_highlight_edit ON highlights;
CREATE TRIGGER trg_log_highlight_edit
  AFTER UPDATE ON highlights
  FOR EACH ROW
  EXECUTE FUNCTION log_highlight_edit();

-- Seed one log row from the existing last-edit snapshot so current diffs
-- still appear after this migration. Skip if logs already exist so this
-- file stays safe to re-run.
INSERT INTO highlight_edit_logs (
  highlight_id,
  user_id,
  previous_text,
  previous_html_content,
  new_text,
  new_html_content,
  created_at
)
SELECT
  id,
  user_id,
  previous_text,
  previous_html_content,
  text,
  html_content,
  COALESCE(updated_at, NOW())
FROM highlights
WHERE (previous_text IS NOT NULL OR previous_html_content IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM highlight_edit_logs);

-- In case this file is re-run after logs already exist.
DELETE FROM highlight_edit_logs
WHERE created_at < NOW() - INTERVAL '90 days';
