-- ============================================================================
-- MIGRATION: Drop FK cascade on notion_sync_queue.highlight_id
-- ============================================================================
-- Why:
--   Previously notion_sync_queue.highlight_id had ON DELETE CASCADE referencing
--   highlights(id). When a user added a highlight then deleted it before syncing,
--   the highlights-row DELETE would race ahead of the queue API's cancel-pending-add
--   logic and CASCADE-remove the pending `add` queue row. The follow-up `delete`
--   queue row was then left orphaned, and on sync it tried to remove content from
--   the Notion page that had never been pushed there — surfacing as a sync failure.
--
-- What changes:
--   Drop the foreign-key constraint entirely. highlight_id stays as a plain UUID
--   column (already nullable). Queue rows now survive a highlights-row DELETE,
--   so the queue API's cancel-pending-add logic can still find and remove them.
--   Application code is responsible for cleanup (the cancel path + sync completion).
-- ============================================================================
-- Date: 2026-05-13
-- ============================================================================

ALTER TABLE notion_sync_queue
  DROP CONSTRAINT IF EXISTS notion_sync_queue_highlight_id_fkey;

-- ============================================================================
-- Migration complete
-- ============================================================================
