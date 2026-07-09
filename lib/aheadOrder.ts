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
// The order is keyed per user + per cycle. A new cycle starts a fresh
// sequence; the previous cycle's key is simply never read again. The offline
// path doesn't touch this at all — while offline the page renders straight
// from the IndexedDB cache, which already holds the rows in frozen order, so
// reconciliation only runs on the online (recompute) path.
//
// Two hardenings on top of the original localStorage-only design:
//   • The sequence is keyed by HIGHLIGHT id, not daily_summary_highlights row
//     id. Re-portioning (apply-frequency / re-tile) deletes every unrated row
//     and re-inserts it with a fresh row id, which used to kill the whole
//     freeze; the underlying highlights survive those events, so their order
//     now does too.
//   • The source of truth is a server row (review_ahead_order, one per
//     user+cycle) so every device resumes the same sequence. localStorage is
//     kept as a mirror for reads that fail (weak signal, or the table not yet
//     migrated) — on any fallback path the behavior is exactly the old
//     device-local freeze.

export interface AheadItem {
  id: string
  date: string
}

// v2: sequences of highlight ids. The unversioned prefix held row-id sequences;
// it's still read once (translated via the current rows) so an in-flight resume
// point survives the upgrade, then superseded by the v2/server copy.
const STORAGE_PREFIX = 'freedwise:ahead-order-v2:'
const LEGACY_STORAGE_PREFIX = 'freedwise:ahead-order:'
const keyFor = (userId: string, month: string) => `${STORAGE_PREFIX}${userId}:${month}`
const legacyKeyFor = (userId: string, month: string) => `${LEGACY_STORAGE_PREFIX}${userId}:${month}`

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
  getLen: (row: T) => number,
  getKey: (row: T) => string = (r) => r.id
): { ordered: T[]; frozenIds: string[] } {
  const natural = roundRobinOrder(rows, getLen)

  if (!frozenIds || frozenIds.length === 0) {
    return { ordered: natural, frozenIds: natural.map(getKey) }
  }

  // Rows grouped by key, each group in natural order. Keys are normally unique
  // within the window (one assignment per highlight per cycle); if a duplicate
  // ever slips in, the extra row falls through to `appended` rather than being
  // silently dropped from the review queue.
  const byKey = new Map<string, T[]>()
  for (const r of natural) {
    const k = getKey(r)
    const bucket = byKey.get(k) || []
    bucket.push(r)
    byKey.set(k, bucket)
  }
  const consumed = new Set<T>()
  const seen = new Set<string>()
  const kept: T[] = []
  for (const id of frozenIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = byKey.get(id)?.shift()
    if (row) {
      kept.push(row)
      consumed.add(row)
    }
  }
  // New rows that appeared since the freeze, in round-robin order among
  // themselves, appended so they never displace anything already sequenced.
  const appended = natural.filter((r) => !consumed.has(r))

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
    return { ordered: natural, frozenIds: natural.map(getKey) }
  }

  const ordered = [...kept, ...appended]
  return { ordered, frozenIds: ordered.map(getKey) }
}

// ─── Persistence ────────────────────────────────────────────────────────────
//
// Server row (review_ahead_order) is the source of truth; localStorage is a
// per-device mirror used when the server read fails. Writers always update the
// mirror, and update the server only when the read succeeded — never clobber
// state we couldn't see.

function readStorageList(key: string): string[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : null
  } catch {
    return null
  }
}

export function readAheadOrder(userId: string, month: string): string[] | null {
  return readStorageList(keyFor(userId, month))
}

/** Pre-v2 sequence of daily_summary_highlights ROW ids (translate before use). */
export function readLegacyAheadOrder(userId: string, month: string): string[] | null {
  return readStorageList(legacyKeyFor(userId, month))
}

/**
 * Read the frozen sequence from the server. `ok: false` means the read itself
 * failed (offline blip, or the table isn't migrated yet) — callers must fall
 * back to the local mirror and skip the server write for this load.
 */
export async function fetchAheadOrder(
  supabase: any,
  userId: string,
  cycleKey: string
): Promise<{ ids: string[] | null; ok: boolean }> {
  try {
    const { data, error } = await supabase
      .from('review_ahead_order')
      .select('ids')
      .eq('user_id', userId)
      .eq('cycle_key', cycleKey)
      .maybeSingle()
    if (error) throw error
    const ids = Array.isArray(data?.ids)
      ? (data.ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : null
    return { ids: ids && ids.length > 0 ? ids : null, ok: true }
  } catch (e) {
    console.warn('Failed to fetch ahead order (falling back to local mirror):', e)
    return { ids: null, ok: false }
  }
}

/** Upsert the frozen sequence to the server. Best-effort: failures only warn. */
export async function storeAheadOrder(
  supabase: any,
  userId: string,
  cycleKey: string,
  ids: string[]
): Promise<void> {
  try {
    const { error } = await supabase
      .from('review_ahead_order')
      .upsert(
        { user_id: userId, cycle_key: cycleKey, ids, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,cycle_key' }
      )
    if (error) throw error
  } catch (e) {
    console.warn('Failed to store ahead order (local mirror still saved):', e)
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

/**
 * Clear every locally saved ahead-order sequence (all users/months, v2 and
 * legacy). Call on logout. The server row deliberately survives — it's what
 * lets the next login (on any device) resume the same sequence.
 */
export function clearAheadOrder(): void {
  if (typeof window === 'undefined') return
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i)
      if (k && (k.startsWith(STORAGE_PREFIX) || k.startsWith(LEGACY_STORAGE_PREFIX))) {
        window.localStorage.removeItem(k)
      }
    }
  } catch {
    /* ignore */
  }
}
