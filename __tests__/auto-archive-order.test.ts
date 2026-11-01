/**
 * The two-consecutive-lows auto-archive rule must not depend on the ORDER the
 * two lows were given in.
 *
 * Edge case: the previous cycle hasn't been fully reviewed when the next cycle
 * starts (catch-up). The user rates a highlight Low on a current-cycle day
 * first, then goes back and rates its still-unrated previous-cycle day Low.
 * That second rating is dated in the OLDER cycle, so a rule that only looks at
 * "this cycle + the one before" never sees the pair and silently never fires.
 */
import { describe, it, expect } from 'vitest'
import { updateHighlightStatsAfterRating } from '@/lib/highlightStats'

type Row = { rating: 'low' | 'med' | 'high'; date: string }

/**
 * Minimal fake of the three reads + one update the routine performs.
 *   highlights        → single(): { unarchived_at, archived }
 *   daily_summary_highlights (.not('rating','is',null)) → all ratings
 *   daily_summary_highlights (.eq('rating','low'))      → lows with summary date
 */
function makeSupabase(
  rows: Row[],
  highlight: { unarchived_at?: string | null; archived?: boolean } = {}
) {
  const updates: any[] = []

  const summaryHighlightsQuery = () => {
    let filterLow = false
    const q: any = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        if (col === 'rating' && val === 'low') filterLow = true
        return q
      },
      not: () => q,
      then: (resolve: any) => {
        const data = filterLow
          ? rows
              .filter((r) => r.rating === 'low')
              .map((r) => ({ rating: r.rating, daily_summary: { date: r.date } }))
          : rows.map((r) => ({ rating: r.rating }))
        return resolve({ data, error: null })
      },
    }
    return q
  }

  const highlightsQuery = () => {
    const q: any = {
      select: () => q,
      eq: () => q,
      single: () =>
        Promise.resolve({
          data: { unarchived_at: highlight.unarchived_at ?? null, archived: highlight.archived ?? false },
          error: null,
        }),
      update: (patch: any) => {
        updates.push(patch)
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }
    return q
  }

  return {
    updates,
    client: {
      from: (table: string) =>
        table === 'highlights' ? highlightsQuery() : summaryHighlightsQuery(),
    } as any,
  }
}

const run = (rows: Row[], ratingDate: string, freq = 1, highlight = {}) => {
  const sb = makeSupabase(rows, highlight)
  return updateHighlightStatsAfterRating(sb.client, { highlightId: 'h1', ratingDate, freq }).then(
    (res) => ({ ...res, patch: sb.updates[0] })
  )
}

describe('auto-archive: two consecutive lows, either order', () => {
  it('archives in chronological order (previous cycle low, then current cycle low)', async () => {
    const res = await run(
      [
        { rating: 'low', date: '2026-10-12' },
        { rating: 'low', date: '2026-11-03' },
      ],
      '2026-11-03'
    )
    expect(res.archivedNow).toBe(true)
    expect(res.patch.archived).toBe(true)
  })

  it('archives in REVERSE order: current cycle rated low first, then catching up on the previous cycle', async () => {
    // Nov already low; the user now goes back to the unfinished October review
    // and rates the same highlight low there. ratingDate is in October.
    const res = await run(
      [
        { rating: 'low', date: '2026-11-03' },
        { rating: 'low', date: '2026-10-12' },
      ],
      '2026-10-12'
    )
    expect(res.archivedNow).toBe(true)
    expect(res.patch.archived).toBe(true)
  })

  it('does not archive on a single low, in either direction', async () => {
    const onlyCurrent = await run([{ rating: 'low', date: '2026-11-03' }], '2026-11-03')
    expect(onlyCurrent.archivedNow).toBe(false)
    expect(onlyCurrent.patch.archived).toBeUndefined()

    const onlyPrevious = await run(
      [
        { rating: 'med', date: '2026-11-03' },
        { rating: 'low', date: '2026-10-12' },
      ],
      '2026-10-12'
    )
    expect(onlyPrevious.archivedNow).toBe(false)
    expect(onlyPrevious.patch.archived).toBeUndefined()
  })

  it('does not archive when the lows are separated by a non-low cycle', async () => {
    const res = await run(
      [
        { rating: 'low', date: '2026-09-10' },
        { rating: 'med', date: '2026-10-12' },
        { rating: 'low', date: '2026-11-03' },
      ],
      '2026-09-10'
    )
    expect(res.archivedNow).toBe(false)
    expect(res.patch.archived).toBeUndefined()
  })

  it('does not archive when the rated cycle itself is not low, even if its neighbours are', async () => {
    // Re-rating the middle cycle to med must not archive via Sep+Nov.
    const res = await run(
      [
        { rating: 'low', date: '2026-09-10' },
        { rating: 'med', date: '2026-10-12' },
        { rating: 'low', date: '2026-11-03' },
      ],
      '2026-10-12'
    )
    expect(res.archivedNow).toBe(false)
    expect(res.patch.archived).toBeUndefined()
  })

  it('reverse order also works across a year boundary and for multi-month cycles', async () => {
    // freq 1: Jan 2027 rated low first, then Dec 2026 caught up.
    const yearEdge = await run(
      [
        { rating: 'low', date: '2027-01-05' },
        { rating: 'low', date: '2026-12-20' },
      ],
      '2026-12-20'
    )
    expect(yearEdge.archivedNow).toBe(true)

    // freq 3: Oct–Dec cycle rated low first, then the Jul–Sep cycle caught up.
    const quarterly = await run(
      [
        { rating: 'low', date: '2026-11-03' },
        { rating: 'low', date: '2026-08-15' },
      ],
      '2026-08-15',
      3
    )
    expect(quarterly.archivedNow).toBe(true)
  })

  it('reverse order still honours the unarchive cut-off', async () => {
    // Unarchived mid-October: the Nov low counts, but a catch-up low dated
    // before the unarchive does not, so no pair forms.
    const res = await run(
      [
        { rating: 'low', date: '2026-11-03' },
        { rating: 'low', date: '2026-10-05' },
      ],
      '2026-10-05',
      1,
      { unarchived_at: '2026-10-15T12:00:00.000Z' }
    )
    expect(res.archivedNow).toBe(false)
    expect(res.patch.archived).toBeUndefined()
  })

  it('reports archivedNow=false when the rule matches but the highlight is already archived', async () => {
    const res = await run(
      [
        { rating: 'low', date: '2026-11-03' },
        { rating: 'low', date: '2026-10-12' },
      ],
      '2026-10-12',
      1,
      { archived: true }
    )
    expect(res.archivedNow).toBe(false)
    expect(res.patch.archived).toBe(true)
  })
})
