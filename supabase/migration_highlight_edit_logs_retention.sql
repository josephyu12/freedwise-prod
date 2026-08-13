-- ============================================================================
-- FOLLOW-UP: 90-day retention for highlight_edit_logs
-- ============================================================================
-- Run this if you already applied migration_highlight_edit_logs.sql before
-- the purge was added. Safe to re-run.
--
-- Retention: rows older than 90 days are deleted. Cleanup runs whenever a
-- new edit is logged. This is a time-based purge, not a per-highlight cap.
-- ============================================================================

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

DELETE FROM highlight_edit_logs
WHERE created_at < NOW() - INTERVAL '90 days';
