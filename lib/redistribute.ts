/**
 * Calls /api/daily/redistribute with the current local date.
 * Deduplicates concurrent calls: if a call is already in-flight, the new call
 * is dropped (returns the in-flight promise). This prevents double-redistribution
 * if the function is triggered again before the first call resolves.
 */

let inFlight: Promise<void> | null = null

function localDateString(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

export async function callRedistribute(highlightIds?: string[]): Promise<void> {
  if (inFlight) return inFlight

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
