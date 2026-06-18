/**
 * Tests for the frozen review-ahead ordering (lib/aheadOrder.ts).
 *
 * The bug being guarded: review-ahead lays out future highlights round-robin
 * (one per day, looping). Recomputing that order every load meant removing a row
 * — e.g. a just-rated highlight getting auto-archived — re-packed the dense
 * round-robin and pulled a later highlight ahead of the resume point. Freezing
 * the order makes a surviving row's position independent of what was removed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  roundRobinOrder,
  reconcileAheadOrder,
  readAheadOrder,
  writeAheadOrder,
  clearAheadOrder,
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

  it('is idempotent: reconciling an unchanged set returns the same order', () => {
    const first = reconcileAheadOrder([A, B, C, D, E], null, getLen)
    const second = reconcileAheadOrder([E, D, C, B, A], first.frozenIds, getLen)
    expect(second.ordered.map((r) => r.id)).toEqual(first.ordered.map((r) => r.id))
    expect(second.frozenIds).toEqual(first.frozenIds)
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

  it('clearAheadOrder removes all saved sequences but leaves other keys', () => {
    writeAheadOrder('u1', '2026-06', ['A'])
    writeAheadOrder('u1', '2026-07', ['B'])
    window.localStorage.setItem('freedwise:manual-offline', '1')

    clearAheadOrder()

    expect(readAheadOrder('u1', '2026-06')).toBeNull()
    expect(readAheadOrder('u1', '2026-07')).toBeNull()
    expect(window.localStorage.getItem('freedwise:manual-offline')).toBe('1')
  })
})
