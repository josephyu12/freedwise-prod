// Pure layout for a cadence change (REVIEW_FREQUENCY_PLAN.md, anchored model).
//
// Rated rows are immutable anchors that this never touches. The ONLY thing
// computed on a switch is where the UNREVIEWED ("to-do") highlights land:
// deterministically packed across [today … cycle end], with each pack day
// pre-loaded by the score of the rated rows already sitting on it so per-day
// TOTALS stay balanced.
//
// Reversibility: the output depends only on (cycle, today, highlights, doneIds,
// ratedScoreByDate). doneIds and ratedScoreByDate are derived from immutable
// rated rows, so when you return to a cadence the inputs are unchanged and this
// reproduces the identical layout. See __tests__/retile.test.ts.

import { Cycle, cycleSeed } from './cycle'
import { packIntoDates, Scored, DayBucket } from './binPack'

export interface RetileInput {
  today: string // YYYY-MM-DD
  cycle: Cycle
  highlights: Scored[] // active highlights with scores
  doneIds: Set<string> // highlights with a rated row dated inside the cycle
  ratedScoreByDate: Map<string, number> // per-day rated load (immutable anchors)
}

/**
 * Day buckets for the unreviewed remainder. Done (rated) highlights are excluded
 * — they keep their existing rated rows untouched. Buckets cover only the days
 * at/after `today` within the cycle.
 */
export function computeToDoLayout(input: RetileInput): DayBucket[] {
  const { today, cycle, highlights, doneIds, ratedScoreByDate } = input

  const unreviewed = highlights.filter((h) => !doneIds.has(h.id))
  if (unreviewed.length === 0) return []

  let packDates = cycle.dates.filter((d) => d >= today)
  if (packDates.length === 0) packDates = [cycle.endDate]

  const initialLoads = new Map<string, number>()
  for (const d of packDates) initialLoads.set(d, ratedScoreByDate.get(d) ?? 0)

  return packIntoDates(unreviewed, packDates, cycleSeed(cycle), initialLoads)
}
