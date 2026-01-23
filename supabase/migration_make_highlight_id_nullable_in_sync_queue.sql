-- ============================================================================
-- MIGRATION: Make highlight_id nullable in notion_sync_queue for delete operations
-- ============================================================================
-- This migration allows highlight_id to be NULL in notion_sync_queue.
-- This is needed for delete operations: when a highlight is deleted, we still
-- need to sync the deletion to Notion, but the highlight_id will be deleted
-- from the database. By making it nullable, we can store delete operations
-- without the foreign key constraint causing issues.
-- ============================================================================
-- Date: 2026-01-XX
-- ============================================================================

-- Drop the NOT NULL constraint on highlight_id
ALTER TABLE notion_sync_queue 
  ALTER COLUMN highlight_id DROP NOT NULL;

-- Note: The foreign key constraint remains, but now NULL values are allowed
-- This means:
-- - For 'add' and 'update' operations: highlight_id will be set (highlight exists)
-- - For 'delete' operations: highlight_id can be NULL (highlight is deleted, but we have text/html to find it in Notion)

-- ============================================================================
-- Migration complete
-- ============================================================================

