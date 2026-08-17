/**
 * Two devices can rate the same daily_summary_highlights row while offline.
 * The earlier tap wins, even if that device syncs second.
 */
import { describe, it, expect } from 'vitest'
import {
  applySummaryHighlightRating,
  earlierRatingWinsFilter,
  toRatedAtIso,
} from '@/lib/applyRating'

function makeRatingTable(initial: { rating: string | null; rated_at: string | null }) {
  const row = { ...initial }
  const writes: Array<{ rating: any; rated_at: string; filter?: string }> = []

  const supabase = {
    from: (table: string) => {
      if (table !== 'daily_summary_highlights') throw new Error(`unexpected table ${table}`)
      let patch: any = null
      let filter: string | undefined
      let id: string | undefined
      const chain: any = {
        update: (vals: any) => {
          patch = vals
          return chain
        },
        eq: (_col: string, val: string) => {
          id = val
          return chain
        },
        or: (f: string) => {
          filter = f
          return chain
        },
        select: (cols?: string) => {
          if (!patch) return chain
          return (async () => {
            // Mirror real (Supabase) PostgREST: an UPDATE with
            // `return=representation` resolves .or() filters against the
            // RETURNED column set, so any filter column missing from the
            // .select() list fails the WHOLE write with 42703. This shipped
            // once — every rating write failed, fell into the offline queue,
            // and was eventually poison-dropped as "discarded". Verified
            // against production; keep this check so it can't ship again.
            if (filter) {
              const selected = (cols || '').split(',').map((c) => c.trim())
              // Each or() condition is `column.operator.value`; the column is
              // the token before the first dot.
              const filterCols = Array.from(
                new Set(filter.split(',').map((cond) => cond.trim().split('.')[0]))
              )
              const missing = filterCols.filter((c) => !selected.includes(c))
              if (missing.length > 0) {
                return {
                  data: null,
                  error: {
                    code: '42703',
                    message: `column daily_summary_highlights.${missing[0]} does not exist`,
                  },
                }
              }
            }
            writes.push({ ...patch, filter })
            const incomingIso = patch.rated_at as string
            const overwrite = !filter
            const wins =
              overwrite ||
              row.rating == null ||
              (row.rated_at != null && row.rated_at > incomingIso)
            if (!wins) return { data: [], error: null }
            row.rating = patch.rating
            row.rated_at = patch.rated_at
            return { data: [{ id, rating: row.rating, rated_at: row.rated_at }], error: null }
          })()
        },
        maybeSingle: async () => ({ data: { rating: row.rating }, error: null }),
      }
      return chain
    },
  }

  return { supabase, row, writes }
}

describe('applySummaryHighlightRating', () => {
  it('quotes the ISO timestamp so PostgREST does not split on colons', () => {
    const iso = toRatedAtIso(1_700_000_000_000)
    expect(earlierRatingWinsFilter(iso)).toBe(`rating.is.null,rated_at.gt."${iso}"`)
    expect(iso).toContain('T')
  })

  it('applies the first rating onto an unrated row', async () => {
    const { supabase, row } = makeRatingTable({ rating: null, rated_at: null })
    const result = await applySummaryHighlightRating(supabase, {
      summaryHighlightId: 'sh1',
      rating: 'high',
      ratedAt: 1_000,
    })
    expect(result).toEqual({ applied: true, rating: 'high' })
    expect(row.rating).toBe('high')
    expect(row.rated_at).toBe(toRatedAtIso(1_000))
  })

  it('keeps the earlier tap when a later device syncs second', async () => {
    const earlier = toRatedAtIso(1_000)
    const { supabase, row } = makeRatingTable({ rating: 'high', rated_at: earlier })
    const result = await applySummaryHighlightRating(supabase, {
      summaryHighlightId: 'sh1',
      rating: 'low',
      ratedAt: 2_000,
    })
    expect(result.applied).toBe(false)
    expect(result.rating).toBe('high')
    expect(row.rating).toBe('high')
    expect(row.rated_at).toBe(earlier)
  })

  it('lets the earlier tap overwrite a later one that already synced', async () => {
    const later = toRatedAtIso(2_000)
    const { supabase, row } = makeRatingTable({ rating: 'low', rated_at: later })
    const result = await applySummaryHighlightRating(supabase, {
      summaryHighlightId: 'sh1',
      rating: 'high',
      ratedAt: 1_000,
    })
    expect(result).toEqual({ applied: true, rating: 'high' })
    expect(row.rating).toBe('high')
    expect(row.rated_at).toBe(toRatedAtIso(1_000))
  })

  it('does not overwrite a legacy rated row with no rated_at', async () => {
    const { supabase, row } = makeRatingTable({ rating: 'med', rated_at: null })
    const result = await applySummaryHighlightRating(supabase, {
      summaryHighlightId: 'sh1',
      rating: 'low',
      ratedAt: 1_000,
    })
    expect(result.applied).toBe(false)
    expect(result.rating).toBe('med')
    expect(row.rating).toBe('med')
  })

  it('does not throw the 42703 representation-filter error (rated_at stays in the select list)', async () => {
    // The mock's select() rejects any or-filter column missing from the
    // representation, exactly like production PostgREST. A plain first-tap
    // write exercising the or-filter must therefore resolve, not throw.
    const { supabase } = makeRatingTable({ rating: null, rated_at: null })
    await expect(
      applySummaryHighlightRating(supabase, {
        summaryHighlightId: 'sh1',
        rating: 'high',
        ratedAt: 1_000,
      })
    ).resolves.toEqual({ applied: true, rating: 'high' })
  })

  it('overwrites when the user is changing a rating they can already see', async () => {
    const { supabase, row } = makeRatingTable({
      rating: 'low',
      rated_at: toRatedAtIso(1_000),
    })
    const result = await applySummaryHighlightRating(supabase, {
      summaryHighlightId: 'sh1',
      rating: 'high',
      ratedAt: 2_000,
      overwrite: true,
    })
    expect(result.applied).toBe(true)
    expect(row.rating).toBe('high')
    expect(row.rated_at).toBe(toRatedAtIso(2_000))
  })
})
