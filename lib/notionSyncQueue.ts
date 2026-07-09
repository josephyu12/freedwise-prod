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

// Attempt cap shared by the poller and the processing route. Must match the
// max_retries default on notion_sync_queue rows.
export const NOTION_SYNC_MAX_RETRIES = 5

/**
 * PostgREST .or() filter selecting queue items actually READY to process:
 * fresh pending items, pending/failed retries whose backoff has elapsed
 * (below the attempt cap), and stale 'processing' claims. Shared by the
 * client-side poller (NotionSyncProcessor) and POST /api/notion/sync so their
 * idea of "work is ready" can never drift — the poller once counted failed
 * items with retry_count<20 while the route only processed <5, so a single
 * permanently-failed item triggered a pointless POST every 10 seconds forever.
 */
export function notionSyncReadyFilter(nowIso: string, staleCutoffIso: string): string {
  const M = NOTION_SYNC_MAX_RETRIES
  return [
    'and(status.eq.pending,retry_count.eq.0)',
    `and(status.eq.pending,retry_count.gt.0,retry_count.lt.${M},or(next_retry_at.is.null,next_retry_at.lte.${nowIso}))`,
    `and(status.eq.failed,retry_count.lt.${M},or(next_retry_at.is.null,next_retry_at.lte.${nowIso}))`,
    `and(status.eq.processing,updated_at.lt.${staleCutoffIso})`,
  ].join(',')
}
