// Shared bin-packer for distributing highlights across the days of a review
// cycle, balancing total character count ("score") per day (LPT: sort desc by
// score, then place each item on the currently-lightest day).
//
// This consolidates the byte-for-byte-identical copy of `seededShuffle` +
// `hashStr` + "assign to lightest day" that previously lived inline in
// app/api/daily/assign, prepare-next-month, and redistribute. The one change in
// shape: buckets are keyed by an explicit ISO `date: string`, not a `day: number
// (1..31)`, because a cycle can span several calendar months.
//
// BACKWARD-COMPAT INVARIANT (see REVIEW_FREQUENCY_PLAN.md §8 #3): for a monthly
// cycle (freq = 1) — i.e. `dates` is exactly day 01..lastDay of one month in
// ascending order and `seed = year*373 + month*31` — the output of
// `packIntoDates` is identical to the old `assignHighlightsToDays`. Two details
// preserve this and MUST NOT change:
//   1. The per-day reshuffle seed is `(seed + dayOfMonth)` where dayOfMonth is
//      parsed from the date — for a monthly cycle that equals the old
//      `(seed + d.day)`.
//   2. Tie-breaking among equally-light days uses the day's array index (its
//      position within `dates`), exactly as the old per-`days`-array logic did.

export interface Scored {
  id: string
  // Only id + score participate in packing; text/html_content are optional
  // legacy fields (the routes now read the stored `score` column instead of
  // downloading content to measure it).
  text?: string
  html_content?: string | null
  score: number // plain-text character count
}

export interface DayBucket {
  date: string // YYYY-MM-DD
  highlights: Scored[]
  totalScore: number
}

/**
 * Seeded shuffle (deterministic): same (array, seed) → same order.
 * Identical to the implementations previously inlined in the daily routes.
 */
export function seededShuffle<T>(array: T[], seed: number): T[] {
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

/** Simple string hash for deterministic per-highlight tie-breaking. */
export function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h
}

const dayOfMonth = (isoDate: string): number => Number(isoDate.slice(8, 10))

/**
 * Distribute `items` across `dates`, balancing total score per day.
 * Returns one bucket PER date in `dates` (in the same order; buckets may be
 * empty). `seed` should be `cycleSeed(cycle)` so the layout is stable for a
 * given cycle and fresh across cycles.
 *
 * `initialLoads` (optional) seeds each day's starting score WITHOUT emitting any
 * highlights for it — use it to account for rows already sitting on a day (e.g.
 * preserved rated highlights) so a re-pack stays balanced across the day TOTALS,
 * not just the newly-placed items. When omitted (or all zero) the result is
 * byte-identical to the original packer, preserving the freq=1 backward-compat
 * invariant above.
 */
export function packIntoDates(
  items: Scored[],
  dates: string[],
  seed: number,
  initialLoads?: Map<string, number>
): DayBucket[] {
  const buckets: DayBucket[] = dates.map((date) => ({
    date,
    highlights: [],
    totalScore: initialLoads?.get(date) ?? 0,
  }))
  if (buckets.length === 0) return buckets

  const shuffled = seededShuffle(items, seed)
  const sorted = [...shuffled].sort((a, b) => b.score - a.score)

  for (const item of sorted) {
    // Find the lightest bucket.
    let minScore = buckets[0].totalScore
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i].totalScore < minScore) minScore = buckets[i].totalScore
    }
    const tiedIndices = buckets.map((_, i) => i).filter((i) => buckets[i].totalScore === minScore)
    // Tie-break using highlight id + seed so the same highlight tends to land on
    // a different day each cycle.
    let idx = tiedIndices[0]
    if (tiedIndices.length > 1) {
      const tieSeed = (seed + hashStr(item.id)) >>> 0
      let r = tieSeed
      const rand = () => {
        r = (r * 9301 + 49297) % 233280
        return r / 233280
      }
      idx = tiedIndices[Math.floor(rand() * tiedIndices.length)]
    }
    buckets[idx].highlights.push(item)
    buckets[idx].totalScore += item.score
  }

  // Shuffle highlights within each day so order is random, not longest-first.
  // Seed by day-of-month so a monthly cycle reproduces the old (seed + d.day).
  for (const b of buckets) {
    b.highlights = seededShuffle(b.highlights, (seed + dayOfMonth(b.date)) >>> 0)
  }

  return buckets
}
