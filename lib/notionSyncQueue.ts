/**
 * Client helper to enqueue Notion sync operations via the deduplicating API.
 * Use this instead of inserting directly into notion_sync_queue.
 *
 * Outbound sync is manual now — users drain the queue from the "Sync to Notion"
 * button on /highlights. This helper only enqueues; it does NOT trigger /api/notion/sync.
 */
export type NotionSyncOperation = 'add' | 'update' | 'delete'

// Per-highlight serialization: ensures rapid sequences like add → delete arrive at
// the server in the order they were issued. Without this, a fire-and-forget add
// followed by a fire-and-forget delete can race; if delete arrives first, the
// cancel-pending-add logic finds nothing and the delete is enqueued as a no-op
// that fails on sync (because the add never made it to Notion).
const inFlightByHighlight = new Map<string, Promise<unknown>>()

async function sendQueueRequest(params: {
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
    if (res.ok && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('notion-sync-queue-updated'))
    }
  } catch (e) {
    console.warn('Error adding to sync queue:', e)
  }
}

export async function addToNotionSyncQueue(params: {
  highlightId: string | null
  operationType: NotionSyncOperation
  text?: string | null
  htmlContent?: string | null
  originalText?: string | null
  originalHtmlContent?: string | null
}): Promise<void> {
  // No highlightId scope (e.g., legacy callers) — just fire.
  if (!params.highlightId) {
    return sendQueueRequest(params)
  }

  const key = params.highlightId
  const previous = inFlightByHighlight.get(key)
  const next = (async () => {
    if (previous) {
      // Don't propagate previous failures — we still want to send our own request.
      await previous.catch(() => {})
    }
    await sendQueueRequest(params)
  })()

  inFlightByHighlight.set(key, next)
  next.finally(() => {
    if (inFlightByHighlight.get(key) === next) {
      inFlightByHighlight.delete(key)
    }
  })

  return next
}
