/**
 * Frequency round-trip (REVIEW_FREQUENCY_PLAN.md D7/D8).
 *
 * When a user switches frequency A → B → A with an unchanged unreviewed library,
 * the unreviewed remainder's per-day layout must come back byte-identical. This
 * models exactly what /api/daily/apply-frequency does for the unreviewed set:
 *
 *     remainingDates = newCycle.dates.filter(d => d >= today)
 *     layout         = packIntoDates(U, remainingDates, cycleSeed(newCycle))
 *
 * The property holds because cycleSeed depends only on the cycle's start month
 * (not "today" or call time) and packIntoDates is pure — so re-deriving the same
 * cycle reproduces the same inputs and therefore the same output.
 */
import { describe, it, expect } from 'vitest'
import { getCycleForDate, cycleSeed } from '@/lib/cycle'
import { packIntoDates, Scored } from '@/lib/binPack'

function makeItems(n: number): Scored[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `hl-${i}-${(i * 2654435761) % 9973}`,
    text: 'x'.repeat((i * 53) % 300 + 1),
    html_content: null,
    score: (i * 53) % 300 + 1,
  }))
}

// Re-pack the unreviewed set the way apply-frequency does for a given frequency.
function rePortion(U: Scored[], today: string, freq: number) {
  const cycle = getCycleForDate(today, freq)
  const remainingDates = cycle.dates.filter((d) => d >= today)
  const buckets = packIntoDates(U, remainingDates, cycleSeed(cycle))
  // Normalize to a comparable shape: date -> ordered highlight ids.
  return buckets.map((b) => ({ date: b.date, ids: b.highlights.map((h) => h.id) }))
}

const layoutKey = (layout: ReturnType<typeof rePortion>) =>
  JSON.stringify(layout.filter((d) => d.ids.length > 0))

describe('frequency round-trip restores the layout (D7)', () => {
  const today = '2026-02-10'
  const U = makeItems(250)

  it('monthly → quarterly → monthly reproduces the monthly layout exactly', () => {
    const a1 = rePortion(U, today, 1)
    const b = rePortion(U, today, 3)
    const a2 = rePortion(U, today, 1)

    expect(layoutKey(a2)).toBe(layoutKey(a1)) // came back identical
    expect(layoutKey(b)).not.toBe(layoutKey(a1)) // B is genuinely a different shape
  })

  it('round-trips for every divisor-of-12 pairing', () => {
    const freqs = [1, 2, 3, 4, 6, 12]
    for (const a of freqs) {
      const before = layoutKey(rePortion(U, today, a))
      for (const b of freqs) {
        if (b === a) continue
        rePortion(U, today, b) // switch away
        const after = layoutKey(rePortion(U, today, a)) // switch back
        expect(after).toBe(before)
      }
    }
  })

  it('order is stable even when the switch path is long (A→B→C→A)', () => {
    const a1 = layoutKey(rePortion(U, today, 2))
    rePortion(U, today, 6)
    rePortion(U, today, 12)
    const a2 = layoutKey(rePortion(U, today, 2))
    expect(a2).toBe(a1)
  })
})

describe('a frequency change actually changes the layout', () => {
  it('the same highlight generally lands on a different day after switching cadence', () => {
    const today = '2026-02-10'
    const U = makeItems(120)
    const monthly = rePortion(U, today, 1)
    const quarterly = rePortion(U, today, 3)

    const dayOf = (layout: ReturnType<typeof rePortion>) => {
      const m = new Map<string, string>()
      for (const d of layout) for (const id of d.ids) m.set(id, d.date)
      return m
    }
    const mDays = dayOf(monthly)
    const qDays = dayOf(quarterly)
    let moved = 0
    for (const id of mDays.keys()) if (mDays.get(id) !== qDays.get(id)) moved++
    // The quarterly cycle is ~3x longer, so the vast majority must move days.
    expect(moved).toBeGreaterThan(U.length / 2)
  })
})

describe('consecutive cycles are not byte-identical (D8)', () => {
  it('the same library lands differently in cycle N vs N+1', () => {
    const U = makeItems(150)
    const c1 = rePortion(U, '2026-01-01', 1) // January
    const c2 = rePortion(U, '2026-02-01', 1) // February — full month, different seed
    // Compare the relative sequence of ids across days; distinct seeds must reorder.
    expect(JSON.stringify(c1.map((d) => d.ids))).not.toBe(JSON.stringify(c2.map((d) => d.ids)))
  })
})
