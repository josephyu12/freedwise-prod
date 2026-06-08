export type DayReviewStatus = 'completed' | 'partial' | 'none'

export interface MonthReviewHighlightRow {
  daily_summary_id: string
  rating: string | null
  // Archived highlights are excluded from the count (see below). Optional/null
  // is treated as not-archived so older cached rows without the flag still work.
  archived?: boolean | null
}

/**
 * Compute the per-day calendar status (green = completed, yellow = partial,
 * none = no dot) from a month's daily_summary_highlights rows.
 *
 * Archived highlights are filtered out BEFORE counting, mirroring the
 * day-detail modal (app/daily/page.tsx loadSummary) and the review flow
 * (app/review/page.tsx loadHighlights), both of which join
 * `highlights!inner` with `.eq('archived', false)`.
 *
 * Without this filter the calendar and the modal disagree: a day holding an
 * archived-but-unrated highlight (archiving never rates or deletes the
 * daily_summary_highlights row — its rating stays null) is counted as
 * `partial` and painted yellow, while the modal — which hides archived
 * highlights — shows every reviewable highlight rated and says "all done".
 */
export function computeMonthReviewStatus(
  summaries: Array<{ id: string; date: string }>,
  highlights: MonthReviewHighlightRow[],
): Map<string, DayReviewStatus> {
  const active = highlights.filter((h) => !h.archived)
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
