/**
 * Client helper to enqueue Notion sync operations via the deduplicating API.
 * Use this instead of inserting directly into notion_sync_queue.
 */
export type NotionSyncOperation = 'add' | 'update' | 'delete'

// Debounce timer for the immediate sync trigger so rapid edits coalesce
// into a single /api/notion/sync call (avoids Notion rate limiting).
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null

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
    // Trigger sync after a short debounce so rapid edits coalesce into one request
    // (important on mobile when the user may leave the app right after saving)
    if (res.ok && (data as { enqueued?: boolean }).enqueued === true) {
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer)
      syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null
        fetch('/api/notion/sync', { method: 'POST' }).catch(() => {})
      }, 2000)
    }
    // 200 with enqueued: false and existing: true means deduplicated — no need to warn
  } catch (e) {
    console.warn('Error adding to sync queue:', e)
  }
}
