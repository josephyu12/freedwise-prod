-- ============================================================================
-- MIGRATION: Realtime change events for notion_sync_queue
-- ============================================================================
-- The Notion sync poller used to query the queue every 10 seconds from every
-- open tab. Adding the table to the supabase_realtime publication lets the
-- client subscribe to postgres_changes instead: the enqueue trigger's INSERT
-- (and retry-state UPDATEs) push an event over the already-open websocket, and
-- the client only polls as a slow safety net. postgres_changes respects RLS,
-- so each user only receives events for their own rows.
--
-- Idempotent. Date: 2026-07-09
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notion_sync_queue'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notion_sync_queue;
  END IF;
END $$;
