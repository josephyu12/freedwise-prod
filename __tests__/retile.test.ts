/**
 * Reversibility + safety of the anchored cadence-switch layout
 * (REVIEW_FREQUENCY_PLAN.md). The contract:
 *   - rated rows are immutable anchors (never appear in the to-do layout);
 *   - "done for a cycle" = a highlight has a rated row dated inside the cycle
 *     (the cross-month duplicate check when growing);
 *   - only the unreviewed remainder is packed, deterministically, across
 *     [today … cycle end];
 *   - so flipping cadences back and forth (with no new reviews) reproduces the
 *     exact same layout per cadence.
 */
import { describe, it, expect } from 'vitest'
import { computeToDoLayout } from '@/lib/retile'
import { getCycleForDate, Cycle } from '@/lib/cycle'
import { Scored } from '@/lib/binPack'

// ─── A small immutable world ────────────────────────────────────────────────
// Active library: 60 highlights of varied length.
function makeHighlights(n: number): Scored[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h-${i}`,
    text: 'x',
    html_content: null,
    score: ((i * 53) % 200) + 1,
  }))
}
const HIGHLIGHTS = makeHighlights(60)
const scoreById = new Map(HIGHLIGHTS.map((h) => [h.id, h.score]))

// Immutable rated rows: (highlightId, date). These NEVER change across flips.
// Some reviewed in June, some back in April/May (only inside the quarter).
const RATED: Array<{ id: string; date: string }> = [
  { id: 'h-0', date: '2026-06-03' },
  { id: 'h-1', date: '2026-06-07' },
  { id: 'h-2', date: '2026-06-10' },
  { id: 'h-3', date: '2026-04-15' }, // in quarter, NOT in June
  { id: 'h-4', date: '2026-05-20' }, // in quarter, NOT in June
]

const TODAY = '2026-06-18'

// Derive the cycle-scoped inputs the route would compute from immutable history.
function deriveInputs(cycle: Cycle) {
  const doneIds = new Set<string>()
  const ratedScoreByDate = new Map<string, number>()
  for (const r of RATED) {
    if (r.date >= cycle.startDate && r.date <= cycle.endDate) {
      doneIds.add(r.id)
      ratedScoreByDate.set(r.date, (ratedScoreByDate.get(r.date) ?? 0) + (scoreById.get(r.id) ?? 0))
    }
  }
  return { doneIds, ratedScoreByDate }
}

function layoutFor(cycle: Cycle) {
  const { doneIds, ratedScoreByDate } = deriveInputs(cycle)
  const buckets = computeToDoLayout({ today: TODAY, cycle, highlights: HIGHLIGHTS, doneIds, ratedScoreByDate })
  // Flatten to a stable {id -> date} placement map for comparison.
  const placement = new Map<string, string>()
  for (const b of buckets) for (const h of b.highlights) placement.set(h.id, b.date)
  return { buckets, placement, doneIds }
}

const monthly = getCycleForDate(TODAY, 1) // June 2026
const quarterly = getCycleForDate(TODAY, 3) // Apr–Jun 2026
const yearly = getCycleForDate(TODAY, 12) // Jan–Dec 2026

describe('cadence switch: done-gate (duplicate check)', () => {
  it('GROW finds reviews in OTHER months of the larger cycle', () => {
    // h-3 (Apr) and h-4 (May) are NOT done in monthly-June…
    expect(layoutFor(monthly).doneIds.has('h-3')).toBe(false)
    expect(layoutFor(monthly).doneIds.has('h-4')).toBe(false)
    // …but ARE done once the cycle grows to the quarter that contains them.
    expect(layoutFor(quarterly).doneIds.has('h-3')).toBe(true)
    expect(layoutFor(quarterly).doneIds.has('h-4')).toBe(true)
  })

  it('a done highlight is never placed as a to-do (no duplication)', () => {
    for (const cycle of [monthly, quarterly, yearly]) {
      const { placement, doneIds } = layoutFor(cycle)
      for (const id of doneIds) expect(placement.has(id)).toBe(false)
    }
  })
})

describe('cadence switch: safety + coverage', () => {
  it('every active non-done highlight is placed exactly once', () => {
    for (const cycle of [monthly, quarterly, yearly]) {
      const { buckets, doneIds } = layoutFor(cycle)
      const placed = buckets.flatMap((b) => b.highlights.map((h) => h.id)).sort()
      const expected = HIGHLIGHTS.map((h) => h.id).filter((id) => !doneIds.has(id)).sort()
      expect(placed).toEqual(expected)
    }
  })

  it('to-do items only ever land on days >= today', () => {
    for (const cycle of [monthly, quarterly, yearly]) {
      for (const b of layoutFor(cycle).buckets) {
        if (b.highlights.length > 0) expect(b.date >= TODAY).toBe(true)
      }
    }
  })
})

describe('cadence switch: reversibility', () => {
  it('is deterministic for a given cadence', () => {
    const a = layoutFor(quarterly).placement
    const b = layoutFor(quarterly).placement
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort())
  })

  it('round-trips: monthly → quarterly → monthly reproduces the monthly layout', () => {
    const before = layoutFor(monthly).placement
    layoutFor(quarterly) // the intermediate switch
    const after = layoutFor(monthly).placement
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort())
  })

  it('round-trips: quarterly → monthly → quarterly reproduces the quarterly layout', () => {
    const before = layoutFor(quarterly).placement
    layoutFor(monthly)
    const after = layoutFor(quarterly).placement
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort())
  })

  it('round-trips across three cadences (1 → 3 → 12 → 3 → 1)', () => {
    const m0 = layoutFor(monthly).placement
    const q0 = layoutFor(quarterly).placement
    layoutFor(yearly)
    const q1 = layoutFor(quarterly).placement
    const m1 = layoutFor(monthly).placement
    expect([...q1.entries()].sort()).toEqual([...q0.entries()].sort())
    expect([...m1.entries()].sort()).toEqual([...m0.entries()].sort())
  })

  it('a different cadence generally yields a different placement (sanity)', () => {
    const m = layoutFor(monthly).placement
    const q = layoutFor(quarterly).placement
    // At least one highlight lands on a different date.
    let differs = false
    for (const [id, d] of m) if (q.get(id) !== d) { differs = true; break }
    expect(differs).toBe(true)
  })
})
