/**
 * Tests for the frozen review-ahead ordering (lib/aheadOrder.ts).
 *
 * The bug being guarded: review-ahead lays out future highlights round-robin
 * (one per day, looping). Recomputing that order every load meant removing a row
 * — e.g. a just-rated highlight getting auto-archived — re-packed the dense
 * round-robin and pulled a later highlight ahead of the resume point. Freezing
 * the order makes a surviving row's position independent of what was removed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  roundRobinOrder,
  reconcileAheadOrder,
  readAheadOrder,
  readLegacyAheadOrder,
  writeAheadOrder,
  clearAheadOrder,
  fetchAheadOrder,
  storeAheadOrder,
  type AheadItem,
} from '@/lib/aheadOrder'

type Row = AheadItem & { len: number }
const getLen = (r: Row) => r.len

// Two future days. Lengths chosen so the within-day sort is a,b,c / d,e.
const A: Row = { id: 'A', date: '2026-06-21', len: 1 }
const B: Row = { id: 'B', date: '2026-06-21', len: 2 }
const C: Row = { id: 'C', date: '2026-06-21', len: 3 }
const D: Row = { id: 'D', date: '2026-06-22', len: 1 }
const E: Row = { id: 'E', date: '2026-06-22', len: 2 }

describe('roundRobinOrder', () => {
  it('takes one (shortest) per day in date order, then loops', () => {
    const out = roundRobinOrder([C, A, E, D, B], getLen).map((r) => r.id)
    // round 0: A(21), D(22); round 1: B(21), E(22); round 2: C(21)
    expect(out).toEqual(['A', 'D', 'B', 'E', 'C'])
  })

  it('is deterministic regardless of input order', () => {
    const a = roundRobinOrder([A, B, C, D, E], getLen).map((r) => r.id)
    const b = roundRobinOrder([E, D, C, B, A], getLen).map((r) => r.id)
    expect(a).toEqual(b)
  })
})

describe('reconcileAheadOrder — freezing', () => {
  it('first load (no freeze) yields the round-robin order and freezes it', () => {
    const { ordered, frozenIds } = reconcileAheadOrder([A, B, C, D, E], null, getLen)
    expect(ordered.map((r) => r.id)).toEqual(['A', 'D', 'B', 'E', 'C'])
    expect(frozenIds).toEqual(['A', 'D', 'B', 'E', 'C'])
  })

  it('REGRESSION: archiving a rated row never pulls a later row ahead of the resume point', () => {
    // Freeze the initial sequence: A D B E C. User rates A, D, B; resume = E.
    const frozen = ['A', 'D', 'B', 'E', 'C']

    // A gets auto-archived → it's no longer in the row set on the next load.
    const survivors = [B, C, D, E]
    const { ordered } = reconcileAheadOrder(survivors, frozen, getLen)

    // Frozen order with A dropped: D B E C. Crucially C stays AFTER E — the old
    // recompute-from-scratch behavior produced D B C E, flipping C ahead of E.
    expect(ordered.map((r) => r.id)).toEqual(['D', 'B', 'E', 'C'])

    const idxE = ordered.findIndex((r) => r.id === 'E')
    const idxC = ordered.findIndex((r) => r.id === 'C')
    expect(idxC).toBeGreaterThan(idxE)
  })

  it('appends genuinely-new rows at the end and freezes them there', () => {
    const frozen = ['A', 'D', 'B', 'E', 'C']
    const F: Row = { id: 'F', date: '2026-06-21', len: 5 }
    const G: Row = { id: 'G', date: '2026-06-23', len: 1 }

    const { ordered, frozenIds } = reconcileAheadOrder([A, B, C, D, E, F, G], frozen, getLen)

    // Existing five keep their frozen order; F and G appended (round-robin among
    // the new ones: G is 23's first, F is 21's next).
    expect(ordered.slice(0, 5).map((r) => r.id)).toEqual(['A', 'D', 'B', 'E', 'C'])
    expect(ordered.slice(5).map((r) => r.id).sort()).toEqual(['F', 'G'])
    expect(frozenIds).toEqual(ordered.map((r) => r.id))
  })

  it('REGRESSION: rebuilds when a re-portion makes new rows dominate (stale freeze cannot bury days)', () => {
    // A stale freeze from before the cycle was re-portioned: it lists row ids
    // that no longer exist (X..Z), plus one that happens to survive (A).
    const staleFrozen = ['X', 'A', 'Y', 'Z']

    // Current rows are the freshly re-portioned set — mostly ids the freeze
    // never saw. Under the old tail-append, B/C/D/E would be exiled to the end
    // and day 2026-06-22 (D, E) would drop out of the visible round-robin pass.
    const { ordered, frozenIds } = reconcileAheadOrder([A, B, C, D, E], staleFrozen, getLen)

    // Rebuilt to the clean round-robin — every day back at its natural position.
    expect(ordered.map((r) => r.id)).toEqual(['A', 'D', 'B', 'E', 'C'])
    expect(frozenIds).toEqual(['A', 'D', 'B', 'E', 'C'])
  })

  it('does NOT rebuild for a large import when existing rows all survive (appends, keeps resume point)', () => {
    // Frozen five all still present (a normal import never deletes rows), plus a
    // big batch of new ones that outnumbers them. survivorRatio is 1.0, so the
    // stale-freeze guard must NOT fire — the five keep their exact frozen order
    // and the newcomers append, preserving the resume point mid-review.
    const frozen = ['A', 'D', 'B', 'E', 'C']
    const news: Row[] = ['F', 'G', 'H', 'I', 'J', 'K'].map((id, i) => ({
      id,
      date: '2026-06-23',
      len: i + 1,
    }))
    const { ordered } = reconcileAheadOrder([A, B, C, D, E, ...news], frozen, getLen)

    expect(ordered.slice(0, 5).map((r) => r.id)).toEqual(['A', 'D', 'B', 'E', 'C'])
    expect(ordered.slice(5).map((r) => r.id)).toEqual(['F', 'G', 'H', 'I', 'J', 'K'])
  })

  it('is idempotent: reconciling an unchanged set returns the same order', () => {
    const first = reconcileAheadOrder([A, B, C, D, E], null, getLen)
    const second = reconcileAheadOrder([E, D, C, B, A], first.frozenIds, getLen)
    expect(second.ordered.map((r) => r.id)).toEqual(first.ordered.map((r) => r.id))
    expect(second.frozenIds).toEqual(first.frozenIds)
  })
})

describe('reconcileAheadOrder — highlight-id keys (getKey)', () => {
  // Rows carry a stable highlight id alongside the volatile row id.
  type KeyedRow = AheadItem & { len: number; hid: string }
  const getHid = (r: KeyedRow) => r.hid
  const kGetLen = (r: KeyedRow) => r.len
  const mk = (id: string, hid: string, date: string, len: number): KeyedRow => ({ id, hid, date, len })

  it('REGRESSION: a re-tile that replaces every row id (same highlights) keeps the frozen order', () => {
    // Freeze on the original rows, keyed by highlight id.
    const before = [
      mk('r1', 'h-a', '2026-07-09', 1),
      mk('r2', 'h-b', '2026-07-09', 2),
      mk('r3', 'h-c', '2026-07-10', 1),
      mk('r4', 'h-d', '2026-07-10', 2),
    ]
    const first = reconcileAheadOrder(before, null, kGetLen, getHid)
    expect(first.frozenIds).toEqual(['h-a', 'h-c', 'h-b', 'h-d'])

    // apply-frequency deletes + re-inserts every row: fresh row ids, shuffled
    // day assignments AND lengths that would produce a different natural order.
    const after = [
      mk('r9', 'h-d', '2026-07-09', 1),
      mk('r8', 'h-c', '2026-07-09', 2),
      mk('r7', 'h-b', '2026-07-11', 1),
      mk('r6', 'h-a', '2026-07-11', 2),
    ]
    const second = reconcileAheadOrder(after, first.frozenIds, kGetLen, getHid)

    // Under row-id keys this was a 0% survivor rebuild (order teleports).
    // Under highlight-id keys every row survives in its frozen slot.
    expect(second.ordered.map(getHid)).toEqual(['h-a', 'h-c', 'h-b', 'h-d'])
    expect(second.frozenIds).toEqual(['h-a', 'h-c', 'h-b', 'h-d'])
  })

  it('never drops a row when two rows share a key (duplicate falls through to appended)', () => {
    const rows = [
      mk('r1', 'h-a', '2026-07-09', 1),
      mk('r2', 'h-a', '2026-07-10', 1), // duplicate assignment (shouldn't happen, must not vanish)
      mk('r3', 'h-b', '2026-07-09', 2),
    ]
    const { ordered } = reconcileAheadOrder(rows, ['h-a', 'h-b'], kGetLen, getHid)
    expect(ordered).toHaveLength(3)
    expect(ordered.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3'])
  })

  it('defaults getKey to the row id (existing callers unchanged)', () => {
    const { frozenIds } = reconcileAheadOrder([A, D], null, getLen)
    expect(frozenIds).toEqual(['A', 'D'])
  })
})

describe('ahead-order persistence', () => {
  beforeEach(() => window.localStorage.clear())

  it('round-trips per user + month and is scoped by both', () => {
    writeAheadOrder('u1', '2026-06', ['A', 'B'])
    expect(readAheadOrder('u1', '2026-06')).toEqual(['A', 'B'])
    // Different user or month → no leakage.
    expect(readAheadOrder('u2', '2026-06')).toBeNull()
    expect(readAheadOrder('u1', '2026-07')).toBeNull()
  })

  it('clearAheadOrder removes all saved sequences (v2 AND legacy) but leaves other keys', () => {
    writeAheadOrder('u1', '2026-06', ['A'])
    writeAheadOrder('u1', '2026-07', ['B'])
    window.localStorage.setItem('freedwise:ahead-order:u1:2026-06', JSON.stringify(['row1']))
    window.localStorage.setItem('freedwise:manual-offline', '1')

    clearAheadOrder()

    expect(readAheadOrder('u1', '2026-06')).toBeNull()
    expect(readAheadOrder('u1', '2026-07')).toBeNull()
    expect(readLegacyAheadOrder('u1', '2026-06')).toBeNull()
    expect(window.localStorage.getItem('freedwise:manual-offline')).toBe('1')
  })

  it('legacy (pre-v2) row-id sequences are readable separately and never shadow v2', () => {
    window.localStorage.setItem('freedwise:ahead-order:u1:2026-07', JSON.stringify(['row1', 'row2']))
    expect(readLegacyAheadOrder('u1', '2026-07')).toEqual(['row1', 'row2'])
    // The old key must NOT be returned by the v2 reader — its ids are row ids.
    expect(readAheadOrder('u1', '2026-07')).toBeNull()
  })
})

describe('ahead-order server persistence', () => {
  const mockSupabase = (result: { data?: any; error?: any } | 'throw') => {
    const maybeSingle = vi.fn(async () => {
      if (result === 'throw') throw new Error('network down')
      return result
    })
    const upsert = vi.fn(async () => {
      if (result === 'throw') throw new Error('network down')
      return result
    })
    const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle, upsert }
    return { from: vi.fn(() => chain), _chain: chain }
  }

  it('fetch returns ids and ok:true when the row exists', async () => {
    const sb = mockSupabase({ data: { ids: ['h-a', 'h-b'] }, error: null })
    expect(await fetchAheadOrder(sb, 'u1', '2026-07')).toEqual({ ids: ['h-a', 'h-b'], ok: true })
  })

  it('fetch returns ids:null but ok:true when no row exists yet (safe to seed)', async () => {
    const sb = mockSupabase({ data: null, error: null })
    expect(await fetchAheadOrder(sb, 'u1', '2026-07')).toEqual({ ids: null, ok: true })
  })

  it('fetch returns ok:false on error (missing table / network) so callers skip the server write', async () => {
    const erroring = mockSupabase({ data: null, error: { message: 'relation does not exist' } })
    expect(await fetchAheadOrder(erroring, 'u1', '2026-07')).toEqual({ ids: null, ok: false })
    const throwing = mockSupabase('throw')
    expect(await fetchAheadOrder(throwing, 'u1', '2026-07')).toEqual({ ids: null, ok: false })
  })

  it('store upserts keyed by user+cycle and swallows failures', async () => {
    const sb = mockSupabase({ error: null })
    await storeAheadOrder(sb, 'u1', '2026-07', ['h-a'])
    expect(sb._chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', cycle_key: '2026-07', ids: ['h-a'] }),
      { onConflict: 'user_id,cycle_key' }
    )
    // Must not throw even when the write fails.
    await expect(storeAheadOrder(mockSupabase('throw'), 'u1', '2026-07', ['h-a'])).resolves.toBeUndefined()
  })
})
