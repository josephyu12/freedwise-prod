-- ============================================================================
-- MIGRATION: Add original_text and original_html_content to notion_sync_queue
-- ============================================================================
-- This migration adds columns to store the original text/html content
-- before an update operation, which is needed for the Notion sync processor
-- to find and update the correct blocks in Notion.
-- ============================================================================
-- Date: 2026-01-XX
-- ============================================================================

-- Add original_text column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'notion_sync_queue' AND column_name = 'original_text'
  ) THEN
    ALTER TABLE notion_sync_queue ADD COLUMN original_text TEXT;
    RAISE NOTICE 'Added original_text column to notion_sync_queue';
  ELSE
    RAISE NOTICE 'Column original_text already exists in notion_sync_queue';
  END IF;
END $$;

-- Add original_html_content column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'notion_sync_queue' AND column_name = 'original_html_content'
  ) THEN
    ALTER TABLE notion_sync_queue ADD COLUMN original_html_content TEXT;
    RAISE NOTICE 'Added original_html_content column to notion_sync_queue';
  ELSE
    RAISE NOTICE 'Column original_html_content already exists in notion_sync_queue';
  END IF;
END $$;

-- ============================================================================
-- Migration complete
-- ============================================================================

