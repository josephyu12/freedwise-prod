/**
 * Cycle math + backward-compat invariants (REVIEW_FREQUENCY_PLAN.md §8).
 *
 * The most important guarantee: with frequency_months = 1 the cycle abstraction
 * collapses EXACTLY onto calendar months, so monthly users are byte-identical to
 * the pre-cycle implementation. If any of these fail, monthly users' assignments
 * would reshuffle — the one outcome we must never ship.
 */
import { describe, it, expect } from 'vitest'
import {
  getCycle,
  getCycleForDate,
  cycleKey,
  cycleKeyForDate,
  nextCycle,
  prevCycle,
  cycleSeed,
  normalizeFreq,
} from '@/lib/cycle'

const pad = (n: number) => String(n).padStart(2, '0')
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate()

const monthSpread: Array<[number, number]> = [
  [2026, 1], [2026, 2], [2026, 6], [2026, 12],
  [2027, 1], [2028, 2], // leap February
  [2024, 12], [2025, 1], // year rollover boundary
]

describe('freq=1 backward-compat invariants', () => {
  it('§8.1 key === YYYY-MM of the month', () => {
    for (const [y, m] of monthSpread) {
      expect(getCycle(y, m, 1).key).toBe(`${y}-${pad(m)}`)
    }
  })

  it('§8.2 dates === days 01..lastDay ascending', () => {
    for (const [y, m] of monthSpread) {
      const dim = daysIn(y, m)
      const expected = Array.from({ length: dim }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`)
      expect(getCycle(y, m, 1).dates).toEqual(expected)
    }
  })

  it('§8.3 cycleSeed === y*373 + m*31 (old bin-pack seed)', () => {
    for (const [y, m] of monthSpread) {
      expect(cycleSeed(getCycle(y, m, 1))).toBe(y * 373 + m * 31)
    }
  })

  it('§8.4 nextCycle === next calendar month', () => {
    expect(nextCycle(getCycle(2026, 1, 1)).key).toBe('2026-02')
    expect(nextCycle(getCycle(2026, 12, 1)).key).toBe('2027-01') // year rollover
    expect(prevCycle(getCycle(2026, 1, 1)).key).toBe('2025-12')
  })

  it('leap February 2028 has 29 days', () => {
    expect(getCycle(2028, 2, 1).dates).toHaveLength(29)
    expect(getCycle(2028, 2, 1).endDate).toBe('2028-02-29')
  })
})

describe('multi-month cycles (calendar-aligned)', () => {
  it('quarterly buckets Jan–Mar, Apr–Jun, …', () => {
    const q1 = getCycle(2026, 2, 3) // Feb is in Q1
    expect(q1.key).toBe('2026-01')
    expect(q1.startDate).toBe('2026-01-01')
    expect(q1.endDate).toBe('2026-03-31')
    expect(q1.dates).toHaveLength(31 + 28 + 31)
    expect(nextCycle(q1).key).toBe('2026-04')
  })

  it('bimonthly Jan–Feb, Mar–Apr, …', () => {
    expect(getCycle(2026, 4, 2).key).toBe('2026-03')
    expect(getCycle(2026, 4, 2).endDate).toBe('2026-04-30')
  })

  it('quarterly Oct–Dec crosses the year boundary', () => {
    const q4 = getCycleForDate('2026-11-15', 3)
    expect(q4.key).toBe('2026-10')
    expect(q4.endDate).toBe('2026-12-31')
    expect(nextCycle(q4).key).toBe('2027-01')
  })

  it('yearly cycle spans Jan 1 – Dec 31; leap year has 366 days', () => {
    const y = getCycleForDate('2028-07-04', 12)
    expect(y.startDate).toBe('2028-01-01')
    expect(y.endDate).toBe('2028-12-31')
    expect(y.dates).toHaveLength(366)
    expect(nextCycle(y).key).toBe('2029-01')
  })

  it('cycleKeyForDate matches getCycleForDate().key', () => {
    expect(cycleKeyForDate('2026-08-09', 3)).toBe('2026-07')
    expect(cycleKey(2026, 8, 3)).toBe('2026-07')
  })
})

describe('cycleSeed is injective (D8 — consecutive cycles never collide)', () => {
  it('no two distinct (startYear, startMonth) share a seed across a wide span', () => {
    const seen = new Map<number, string>()
    for (let y = 2000; y <= 2100; y++) {
      for (let m = 1; m <= 12; m++) {
        const s = cycleSeed(getCycle(y, m, 1))
        const key = `${y}-${pad(m)}`
        expect(seen.has(s)).toBe(false)
        seen.set(s, key)
      }
    }
  })

  it('consecutive cycles get distinct seeds for every frequency', () => {
    for (const f of [1, 2, 3, 4, 6, 12]) {
      let c = getCycle(2026, 1, f)
      for (let i = 0; i < 30; i++) {
        const n = nextCycle(c)
        expect(cycleSeed(n)).not.toBe(cycleSeed(c))
        c = n
      }
    }
  })
})

describe('normalizeFreq clamps to [1,12]', () => {
  it('handles junk', () => {
    expect(normalizeFreq(0)).toBe(1)
    expect(normalizeFreq(-3)).toBe(1)
    expect(normalizeFreq(13)).toBe(12)
    expect(normalizeFreq(undefined)).toBe(1)
    expect(normalizeFreq(NaN)).toBe(1)
    expect(normalizeFreq(3)).toBe(3)
  })
})
