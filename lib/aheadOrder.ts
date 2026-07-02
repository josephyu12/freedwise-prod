// Stable ("frozen") ordering for review-ahead highlights.
//
// The problem this solves: review-ahead lays out future highlights round-robin —
// one (shortest) per future day, looping — so you skim across the month instead
// of grinding one day at a time. That order is computed from the current row
// set on every load. The instant the set changes (a highlight you just rated
// gets auto-archived, or a new one is assigned), recomputing re-packs the dense
// round-robin and a highlight from a later round can cross *ahead* of one you
// hadn't reached yet — the "a couple of dots jumped earlier than where I left
// off" bug.
//
// The fix is to FREEZE the order: compute the round-robin once, persist the
// sequence of row ids, and on later loads render in that saved order rather than
// recomputing. Reconciliation is deliberately minimal and monotonic:
//   • rows still present keep their exact frozen position,
//   • rows that vanished (archived / deleted / rolled into "today") drop out and
//     the gap simply closes — nothing else moves,
//   • genuinely-new rows are appended at the end (in round-robin order among
//     themselves) and become frozen there.
// Because every surviving row's position is independent of what was removed, the
// resume point (first unrated) can never jump backwards.
//
// The order is keyed per user + per calendar month. A new month starts a fresh
// sequence; the previous month's key is simply never read again (cleared on
// logout). The offline path doesn't touch this at all — while offline the page
// renders straight from the IndexedDB cache, which already holds the rows in
// frozen order, so reconciliation only runs on the online (recompute) path.

export interface AheadItem {
  id: string
  date: string
}

const STORAGE_PREFIX = 'freedwise:ahead-order:'
const keyFor = (userId: string, month: string) => `${STORAGE_PREFIX}${userId}:${month}`

/**
 * Round-robin: one (shortest) item per day in date order, then loop. Ties on
 * length break by id so the result is deterministic. Pure — no I/O.
 */
export function roundRobinOrder<T extends AheadItem>(
  rows: T[],
  getLen: (row: T) => number
): T[] {
  const byDate = new Map<string, T[]>()
  for (const r of rows) {
    const bucket = byDate.get(r.date) || []
    bucket.push(r)
    byDate.set(r.date, bucket)
  }
  const dates = Array.from(byDate.keys()).sort()
  for (const d of dates) {
    byDate.get(d)!.sort((a, b) => {
      const la = getLen(a)
      const lb = getLen(b)
      if (la !== lb) return la - lb
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  }
  const out: T[] = []
  for (let round = 0; ; round++) {
    let addedThisRound = false
    for (const d of dates) {
      const bucket = byDate.get(d)!
      if (round < bucket.length) {
        out.push(bucket[round])
        addedThisRound = true
      }
    }
    if (!addedThisRound) break
  }
  return out
}

/**
 * Apply the frozen sequence to the current row set.
 *
 * Returns the rows in their stable order plus the sequence of ids to persist
 * (frozen survivors in place, then any new rows appended). When there's no
 * frozen sequence yet (first ahead load this month) the natural round-robin
 * order is used and becomes the freeze.
 */
export function reconcileAheadOrder<T extends AheadItem>(
  rows: T[],
  frozenIds: string[] | null,
  getLen: (row: T) => number
): { ordered: T[]; frozenIds: string[] } {
  const natural = roundRobinOrder(rows, getLen)

  if (!frozenIds || frozenIds.length === 0) {
    return { ordered: natural, frozenIds: natural.map((r) => r.id) }
  }

  const byId = new Map(rows.map((r) => [r.id, r] as const))
  const seen = new Set<string>()
  const kept: T[] = []
  for (const id of frozenIds) {
    const row = byId.get(id)
    if (row && !seen.has(id)) {
      kept.push(row)
      seen.add(id)
    }
  }
  // New rows that appeared since the freeze, in round-robin order among
  // themselves, appended so they never displace anything already sequenced.
  const appended = natural.filter((r) => !seen.has(r.id))

  // Stale-freeze guard. Tail-appending is only correct for an INCREMENTAL delta
  // (a handful of newly-imported highlights, whose existing rows all survive).
  // When the cycle is re-portioned — apply-frequency / re-tile DELETES every
  // unrated to-do row and re-inserts it with a fresh id — the frozen sequence's
  // ids nearly all point at rows that no longer exist, and the re-created days
  // arrive as "new" rows. Tail-appending would then exile whole days to the very
  // end, so they vanish from the visible round-robin pass ("it skipped July 6
  // and 19"). Detect that case by BOTH tells and rebuild from the natural
  // round-robin so every day returns to its proper position:
  //   • survivors are a small minority of the frozen sequence (its world was
  //     replaced), and
  //   • the new rows dominate the current set.
  // This is deliberately narrow. A normal import keeps every existing row (high
  // survivor ratio) → still appends. Review/archival removes rows but adds none
  // (appended === 0) → never rebuilds, so the resume-point guarantee the freeze
  // exists for is fully preserved.
  const survivorRatio = frozenIds.length > 0 ? kept.length / frozenIds.length : 1
  if (survivorRatio < 0.5 && appended.length > kept.length) {
    return { ordered: natural, frozenIds: natural.map((r) => r.id) }
  }

  const ordered = [...kept, ...appended]
  return { ordered, frozenIds: ordered.map((r) => r.id) }
}

// ─── Persistence (localStorage, per user + month) ──────────────────────────

export function readAheadOrder(userId: string, month: string): string[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(keyFor(userId, month))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : null
  } catch {
    return null
  }
}

export function writeAheadOrder(userId: string, month: string, ids: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(keyFor(userId, month), JSON.stringify(ids))
  } catch {
    // Ignore quota / private-mode failures — a missing freeze just falls back to
    // recomputing the round-robin, which is still correct, just not pinned.
  }
}

/** Clear every saved ahead-order sequence (all users/months). Call on logout. */
export function clearAheadOrder(): void {
  if (typeof window === 'undefined') return
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(STORAGE_PREFIX)) window.localStorage.removeItem(k)
    }
  } catch {
    /* ignore */
  }
}
