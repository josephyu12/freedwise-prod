/**
 * Regression test: archived highlights must not paint a calendar day yellow.
 *
 * Root cause: the calendar coloring (app/daily/page.tsx loadMonthReviewStatus)
 * counted EVERY daily_summary_highlights row for a day — no join, no archived
 * filter — while the day-detail modal (loadSummary) and the review flow
 * (app/review/page.tsx) both join `highlights!inner` with archived = false.
 *
 * Archiving a highlight never rates or deletes its daily_summary_highlights
 * row; the row's rating stays null. So a day with one rated, active highlight
 * plus one archived, unrated highlight was counted as 1-of-2 reviewed →
 * 'partial' → yellow. The modal hid the archived one, saw 1-of-1 reviewed, and
 * said "all done". The two views disagreed — the reported "Jun 1 stays yellow
 * but the modal says all done" bug.
 *
 * The fix moves the archived-exclusion into computeMonthReviewStatus, which
 * filters archived rows before counting. This test pins that behavior: the
 * archived-unrated day must read 'completed', not 'partial'.
 */
import { describe, it, expect } from 'vitest'
import { computeMonthReviewStatus } from '@/lib/monthReviewStatus'

describe('computeMonthReviewStatus', () => {
  it('treats a day as completed when the only unrated highlight is archived', () => {
    const summaries = [{ id: 's1', date: '2026-06-01' }]
    const highlights = [
      { daily_summary_id: 's1', rating: 'high', archived: false },
      // archived + never rated — used to drag the day to 'partial'
      { daily_summary_id: 's1', rating: null, archived: true },
    ]

    const status = computeMonthReviewStatus(summaries, highlights)

    expect(status.get('2026-06-01')).toBe('completed')
  })

  it('still marks a day partial when an ACTIVE highlight is unrated', () => {
    const summaries = [{ id: 's1', date: '2026-06-02' }]
    const highlights = [
      { daily_summary_id: 's1', rating: 'high', archived: false },
      { daily_summary_id: 's1', rating: null, archived: false },
    ]

    expect(computeMonthReviewStatus(summaries, highlights).get('2026-06-02')).toBe('partial')
  })

  it('marks a day with no active highlights as none', () => {
    const summaries = [{ id: 's1', date: '2026-06-03' }]
    const highlights = [
      { daily_summary_id: 's1', rating: null, archived: true },
      { daily_summary_id: 's1', rating: 'low', archived: true },
    ]

    expect(computeMonthReviewStatus(summaries, highlights).get('2026-06-03')).toBe('none')
  })

  it('marks a fully-rated active day completed', () => {
    const summaries = [{ id: 's1', date: '2026-06-04' }]
    const highlights = [
      { daily_summary_id: 's1', rating: 'high', archived: false },
      { daily_summary_id: 's1', rating: 'med', archived: false },
    ]

    expect(computeMonthReviewStatus(summaries, highlights).get('2026-06-04')).toBe('completed')
  })

  it('marks a day with zero highlights as none', () => {
    const summaries = [{ id: 's1', date: '2026-06-05' }]
    expect(computeMonthReviewStatus(summaries, []).get('2026-06-05')).toBe('none')
  })
})
