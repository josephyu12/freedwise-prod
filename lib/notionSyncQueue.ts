/**
 * Client helper to enqueue Notion sync operations via the deduplicating API.
 * Use this instead of inserting directly into notion_sync_queue.
 */
export type NotionSyncOperation = 'add' | 'update' | 'delete'

export async function addToNotionSyncQueue(params: {
  highlightId: string | null
  operationType: NotionSyncOperation
  text?: string | null
  htmlContent?: string | null
  originalText?: string | null
  originalHtmlContent?: string | null
}): Promise<void> {
  try {
    const res = await fetch('/api/notion/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        highlightId: params.highlightId,
        operationType: params.operationType,
        text: params.text ?? null,
        htmlContent: params.htmlContent ?? null,
        originalText: params.originalText ?? null,
        originalHtmlContent: params.originalHtmlContent ?? null,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok && res.status >= 500) {
      console.warn('Failed to add to sync queue:', (data as { error?: string }).error || res.statusText)
    }
    // Trigger sync immediately so changes reach Notion without waiting for the next 10s poll
    // (important on mobile when the user may leave the app right after saving)
    if (res.ok && (data as { enqueued?: boolean }).enqueued === true) {
      fetch('/api/notion/sync', { method: 'POST' }).catch(() => {})
    }
    // 200 with enqueued: false and existing: true means deduplicated — no need to warn
  } catch (e) {
    console.warn('Error adding to sync queue:', e)
  }
}
