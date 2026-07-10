/**
 * Calls /api/daily/redistribute with the current local date.
 * Deduplicates concurrent calls: while a call is in flight, new calls don't
 * fire immediately — but their payload is NOT dropped. The requested ids are
 * unioned and ONE follow-up redistribute runs after the in-flight call
 * finishes (the in-flight request was computed from pre-change state, so a
 * call arriving mid-flight always warrants a fresh pass).
 */

let inFlight: Promise<void> | null = null
let queued: { ids: Set<string>; any: boolean } | null = null
let followUp: Promise<void> | null = null

function localDateString(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

export async function callRedistribute(highlightIds?: string[]): Promise<void> {
  if (inFlight) {
    if (!queued) queued = { ids: new Set<string>(), any: false }
    if (highlightIds && highlightIds.length > 0) {
      for (const id of highlightIds) queued.ids.add(id)
    } else {
      queued.any = true
    }
    if (!followUp) {
      followUp = inFlight.then(() => {
        const q = queued
        queued = null
        followUp = null
        // A call with ids also performs everything a no-ids call does server-side,
        // so the union (or a plain call when only no-ids calls were queued) covers
        // every request that arrived mid-flight.
        return callRedistribute(q && q.ids.size > 0 ? Array.from(q.ids) : undefined)
      })
    }
    return followUp
  }

  const body: Record<string, unknown> = { localDate: localDateString() }
  if (highlightIds && highlightIds.length > 0) body.highlightIds = highlightIds

  inFlight = fetch('/api/daily/redistribute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) res.json().catch(() => null).then((e) => console.warn('Redistribute failed:', e))
    })
    .catch((err) => console.warn('Failed to redistribute daily assignments:', err))
    .finally(() => { inFlight = null })

  return inFlight
}
