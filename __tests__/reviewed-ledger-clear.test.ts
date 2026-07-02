/**
 * Regression test: clearing a rating must remove the cycle's "reviewed" checkmark
 * (highlight_months_reviewed) unless the highlight still has another rated day in
 * the same cycle. Leaving the checkmark behind creates a phantom that makes
 * redistribute treat the day as empty and skews reviewed-count stats.
 */
import { describe, it, expect } from 'vitest'
import { removeReviewedOnClear } from '@/lib/reviewedLedger'

// Chainable Supabase stub. `daily_summaries` and `daily_summary_highlights`
// queries resolve to the supplied data; `highlight_months_reviewed.delete()`
// records its .eq() filters so the test can assert what would be deleted.
function makeSupabase(opts: { summaries: any[]; remainingRated: any[]; deletes: Record<string, any>[] }) {
  const q = (result: any): any => ({
    select: () => q(result),
    eq: () => q(result),
    gte: () => q(result),
    lte: () => q(result),
    not: () => q(result),
    in: () => q(result),
    limit: () => q(result),
    then: (r: any) => r(result),
  })
  return {
    from: (table: string) => {
      if (table === 'daily_summaries') return q({ data: opts.summaries, error: null })
      if (table === 'daily_summary_highlights') return q({ data: opts.remainingRated, error: null })
      // highlight_months_reviewed
      return {
        delete: () => {
          const rec: Record<string, any> = {}
          const chain: any = {
            eq: (col: string, val: any) => {
              rec[col] = val
              return chain
            },
            then: (r: any) => {
              opts.deletes.push(rec)
              return r({ error: null })
            },
          }
          return chain
        },
      }
    },
  } as any
}

describe('removeReviewedOnClear', () => {
  it('deletes the cycle checkmark when no other rated day remains (freq=2 → key 2026-07)', async () => {
    const deletes: Record<string, any>[] = []
    const sb = makeSupabase({ summaries: [{ id: 's1' }, { id: 's2' }], remainingRated: [], deletes })

    await removeReviewedOnClear(sb, {
      userId: 'u1',
      highlightId: 'h1',
      summaryDate: '2026-08-15', // Jul–Aug cycle under freq=2
      freq: 2,
    })

    expect(deletes).toEqual([{ highlight_id: 'h1', month_year: '2026-07' }])
  })

  it('keeps the checkmark when another rated day for the highlight remains in the cycle', async () => {
    const deletes: Record<string, any>[] = []
    const sb = makeSupabase({ summaries: [{ id: 's1' }], remainingRated: [{ id: 'stillRated' }], deletes })

    await removeReviewedOnClear(sb, {
      userId: 'u1',
      highlightId: 'h1',
      summaryDate: '2026-08-15',
      freq: 2,
    })

    expect(deletes).toEqual([]) // still reviewed elsewhere this cycle → no delete
  })
})
