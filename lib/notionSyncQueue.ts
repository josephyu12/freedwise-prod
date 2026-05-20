/**
 * Notion sync-queue client helper.
 *
 * Enqueueing is NO LONGER done from the client. A database trigger on the
 * `highlights` table (see supabase/migration_notion_sync_trigger.sql) writes
 * the matching `notion_sync_queue` row in the SAME transaction as the highlight
 * insert/update/delete. The queue and the highlights table therefore can never
 * disagree: there is no separate network call left that can fail independently
 * of the highlight write.
 *
 * This module is kept so existing call sites keep compiling and so the Notion
 * sync counter in the header refreshes promptly after a change.
 * `addToNotionSyncQueue` performs NO network request and writes nothing — it
 * only tells `NotionSyncButton` to re-read the (already-updated) queue count.
 */
export type NotionSyncOperation = 'add' | 'update' | 'delete'

/**
 * Notify the Notion sync badge that the queue may have changed so it refetches
 * its count. The queue row itself was already written atomically by the
 * `enqueue_notion_sync` database trigger. No-op on the server.
 *
 * The parameter shape is retained only for backwards compatibility with
 * existing call sites; the values are intentionally ignored.
 */
export async function addToNotionSyncQueue(_params: {
  highlightId: string | null
  operationType: NotionSyncOperation
  text?: string | null
  htmlContent?: string | null
  originalText?: string | null
  originalHtmlContent?: string | null
}): Promise<void> {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('notion-sync-queue-updated'))
  }
}
