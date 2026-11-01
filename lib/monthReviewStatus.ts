export type DayReviewStatus = 'completed' | 'partial' | 'none'

export interface MonthReviewHighlightRow {
  daily_summary_id: string
  rating: string | null
  // Optional/null is treated as not-archived so older cached rows without the
  // flag still work.
  archived?: boolean | null
}

/**
 * Is this assignment row part of the day as the user sees it?
 *
 * THE visibility rule for archived highlights on the calendar, shared by the
 * day view (app/daily/page.tsx loadSummary), the calendar dots below, and the
 * queued-write overlay (lib/pendingOverlay.ts):
 *
 *   - A RATED row stays visible even after the highlight is archived. The
 *     rating is history — "I reviewed this on Oct 12 and gave it Low" — and
 *     the day keeps showing it (badged Archived) so the record is intact and
 *     a two-lows auto-archive is explainable from the day that triggered it.
 *   - An UNRATED row of an archived highlight is hidden. It was never
 *     reviewed, so it isn't history, and counting it would paint the day
 *     yellow for work that can no longer be done.
 */
export function isVisibleAssignment(row: { rating: string | null; archived?: boolean | null }): boolean {
  return !row.archived || row.rating !== null
}

/**
 * Compute the per-day calendar status (green = completed, yellow = partial,
 * none = no dot) from a month's daily_summary_highlights rows.
 *
 * Rows are filtered through isVisibleAssignment BEFORE counting so the
 * calendar and the day-detail modal agree. Archived-but-unrated rows are
 * dropped (archiving never rates or deletes the daily_summary_highlights row —
 * its rating stays null — so without this a day holding one was counted as
 * `partial` and painted yellow while the modal said "all done"). Archived
 * rows that WERE rated count as rated, so they can never turn a green day
 * yellow.
 */
export function computeMonthReviewStatus(
  summaries: Array<{ id: string; date: string }>,
  highlights: MonthReviewHighlightRow[],
): Map<string, DayReviewStatus> {
  const active = highlights.filter(isVisibleAssignment)
  const statusMap = new Map<string, DayReviewStatus>()

  for (const summary of summaries) {
    const dayHighlights = active.filter((h) => h.daily_summary_id === summary.id)
    const total = dayHighlights.length
    const rated = dayHighlights.filter((h) => h.rating !== null).length

    if (total === 0) {
      statusMap.set(summary.date, 'none')
    } else if (rated === total) {
      statusMap.set(summary.date, 'completed')
    } else if (rated > 0) {
      statusMap.set(summary.date, 'partial')
    } else {
      statusMap.set(summary.date, 'none')
    }
  }

  return statusMap
}
