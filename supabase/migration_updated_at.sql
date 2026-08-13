-- Migration: Add updated_at column to highlights
-- Tracks when a highlight's text or html_content was last edited.
-- Also snapshots the pre-edit content so the recent-edits page can show a diff.

ALTER TABLE highlights ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS previous_text TEXT;
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS previous_html_content TEXT;

-- Auto-set updated_at and snapshot previous content on text/html_content edits
CREATE OR REPLACE FUNCTION set_highlight_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.text IS DISTINCT FROM NEW.text
     OR OLD.html_content IS DISTINCT FROM NEW.html_content THEN
    NEW.previous_text = OLD.text;
    NEW.previous_html_content = OLD.html_content;
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_highlight_updated_at ON highlights;
CREATE TRIGGER trg_highlight_updated_at
  BEFORE UPDATE ON highlights
  FOR EACH ROW EXECUTE FUNCTION set_highlight_updated_at();

-- Index for sorting by recently edited
CREATE INDEX IF NOT EXISTS idx_highlights_updated_at ON highlights(updated_at DESC NULLS LAST);
