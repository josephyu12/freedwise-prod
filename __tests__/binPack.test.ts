/**
 * packIntoDates must be byte-identical to the old `assignHighlightsToDays` when
 * given a full calendar month and seed = year*373 + month*31 (the freq=1 case).
 * This is REVIEW_FREQUENCY_PLAN.md §8 invariant #3 — the guarantee that monthly
 * users' daily assignments don't reshuffle.
 *
 * The oracle below is a verbatim copy of the pre-cycle algorithm.
 */
import { describe, it, expect } from 'vitest'
import { packIntoDates, Scored } from '@/lib/binPack'
import { getCycle, cycleSeed } from '@/lib/cycle'

// ─── Oracle: the original assignHighlightsToDays (verbatim) ──────────────────
function seededShuffle<T>(array: T[], seed: number): T[] {
  const shuffled = [...array]
  let random = seed
  const seededRandom = () => {
    random = (random * 9301 + 49297) % 233280
    return random / 233280
  }
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}
function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h
}
interface DayAssignment { day: number; highlights: Scored[]; totalScore: number }
function assignHighlightsToDays(highlights: Scored[], daysInMonth: number, year: number, month: number): DayAssignment[] {
  const seed = year * 373 + month * 31
  const shuffledHighlights = seededShuffle(highlights, seed)
  const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)
  const days: DayAssignment[] = Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, highlights: [], totalScore: 0 }))
  for (const highlight of sortedHighlights) {
    let minScore = days[0].totalScore
    for (let i = 1; i < days.length; i++) if (days[i].totalScore < minScore) minScore = days[i].totalScore
    const tiedIndices = days.map((_, i) => i).filter((i) => days[i].totalScore === minScore)
    let minDayIndex = tiedIndices[0]
    if (tiedIndices.length > 1) {
      const tieSeed = (seed + hashStr(highlight.id)) >>> 0
      let r = tieSeed
      const rand = () => { r = (r * 9301 + 49297) % 233280; return r / 233280 }
      minDayIndex = tiedIndices[Math.floor(rand() * tiedIndices.length)]
    }
    days[minDayIndex].highlights.push(highlight)
    days[minDayIndex].totalScore += highlight.score
  }
  for (const d of days) d.highlights = seededShuffle(d.highlights, (seed + d.day) >>> 0)
  return days
}

function makeItems(n: number): Scored[] {
  // Deterministic varied scores + ids.
  return Array.from({ length: n }, (_, i) => ({
    id: `hl-${i}-${(i * 2654435761) % 1000}`,
    text: 'x'.repeat((i * 37) % 240 + 1),
    html_content: null,
    score: (i * 37) % 240 + 1,
  }))
}

describe('packIntoDates byte-identical to old packer (freq=1)', () => {
  const cases: Array<[number, number, number]> = [
    [2026, 1, 200],
    [2026, 2, 137], // 28-day month
    [2028, 2, 500], // leap February
    [2026, 6, 50],  // 30-day month
    [2026, 12, 1000],
  ]

  for (const [year, month, count] of cases) {
    it(`${year}-${month} with ${count} items`, () => {
      const items = makeItems(count)
      const daysInMonth = new Date(year, month, 0).getDate()

      const oracle = assignHighlightsToDays(items, daysInMonth, year, month)
      const cycle = getCycle(year, month, 1)
      const buckets = packIntoDates(items, cycle.dates, cycleSeed(cycle))

      expect(buckets).toHaveLength(daysInMonth)
      for (let i = 0; i < daysInMonth; i++) {
        const expectedDate = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
        expect(buckets[i].date).toBe(expectedDate)
        expect(buckets[i].highlights.map((h) => h.id)).toEqual(oracle[i].highlights.map((h) => h.id))
        expect(buckets[i].totalScore).toBe(oracle[i].totalScore)
      }
    })
  }
})

describe('packIntoDates general properties', () => {
  it('every item lands exactly once across the cycle', () => {
    const items = makeItems(300)
    const cycle = getCycle(2026, 7, 3) // quarterly, ~92 days
    const buckets = packIntoDates(items, cycle.dates, cycleSeed(cycle))
    const placed = buckets.flatMap((b) => b.highlights.map((h) => h.id)).sort()
    expect(placed).toEqual(items.map((i) => i.id).sort())
  })

  it('is deterministic for a given (items, dates, seed)', () => {
    const items = makeItems(120)
    const cycle = getCycle(2026, 1, 6)
    const a = packIntoDates(items, cycle.dates, cycleSeed(cycle))
    const b = packIntoDates(items, cycle.dates, cycleSeed(cycle))
    expect(a.map((x) => x.highlights.map((h) => h.id))).toEqual(b.map((x) => x.highlights.map((h) => h.id)))
  })

  it('empty dates → empty result, empty items → all-empty buckets', () => {
    expect(packIntoDates(makeItems(5), [], 123)).toEqual([])
    const cycle = getCycle(2026, 2, 1)
    const buckets = packIntoDates([], cycle.dates, cycleSeed(cycle))
    expect(buckets).toHaveLength(28)
    expect(buckets.every((b) => b.highlights.length === 0)).toBe(true)
  })
})

describe('packIntoDates load-aware (initialLoads)', () => {
  it('an all-zero initialLoads map is byte-identical to omitting it', () => {
    const items = makeItems(200)
    const cycle = getCycle(2026, 6, 1)
    const zeros = new Map(cycle.dates.map((d) => [d, 0]))
    const a = packIntoDates(items, cycle.dates, cycleSeed(cycle))
    const b = packIntoDates(items, cycle.dates, cycleSeed(cycle), zeros)
    expect(b.map((x) => x.highlights.map((h) => h.id))).toEqual(a.map((x) => x.highlights.map((h) => h.id)))
    expect(b.map((x) => x.totalScore)).toEqual(a.map((x) => x.totalScore))
  })

  it('seeded day load steers new items toward the lighter days (even TOTALS)', () => {
    const items = makeItems(200)
    const cycle = getCycle(2026, 6, 1)
    // Pre-load the first half of the month very heavily (as if already reviewed).
    const loads = new Map<string, number>()
    cycle.dates.forEach((d, i) => loads.set(d, i < 15 ? 5000 : 0))
    const buckets = packIntoDates(items, cycle.dates, cycleSeed(cycle), loads)

    // Newly-placed score should pile onto the originally-light (later) days.
    const placedEarly = buckets.slice(0, 15).reduce((s, b) => s + b.highlights.reduce((t, h) => t + h.score, 0), 0)
    const placedLate = buckets.slice(15).reduce((s, b) => s + b.highlights.reduce((t, h) => t + h.score, 0), 0)
    expect(placedLate).toBeGreaterThan(placedEarly)

    // And the resulting per-day TOTALS (preload + placed) should be far flatter
    // than they'd be if we ignored the preload.
    const totals = buckets.map((b) => b.totalScore)
    const spread = Math.max(...totals) - Math.min(...totals)
    const naiveSpread = 5000 // the preload gap alone, if new items were spread evenly
    expect(spread).toBeLessThan(naiveSpread)
  })

  it('still places every item exactly once with initialLoads', () => {
    const items = makeItems(120)
    const cycle = getCycle(2026, 7, 3)
    const loads = new Map(cycle.dates.map((d, i) => [d, (i % 5) * 1000]))
    const buckets = packIntoDates(items, cycle.dates, cycleSeed(cycle), loads)
    const placed = buckets.flatMap((b) => b.highlights.map((h) => h.id)).sort()
    expect(placed).toEqual(items.map((i) => i.id).sort())
  })
})
