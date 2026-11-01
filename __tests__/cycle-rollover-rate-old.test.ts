/**
 * Cycle rollover: once a new cycle has begun, rating (or clearing) a highlight
 * that belongs to a day of the PREVIOUS cycle must still land against that
 * older cycle — never against "today's" cycle.
 *
 * Pins the contract across the boundaries that actually come up in production:
 *   - Oct 31 → Nov 1 (month boundary, same year)
 *   - Dec 31 → Jan 1 (month + year boundary)
 * for the monthly default (freq=1) and for a multi-month cadence where the
 * two dates may or may not share a cycle.
 *
 * Covered here (the rate-review replay is covered by
 * offline-replay-review-cycle-key.test.ts):
 *   1. offline `rate-daily` replay — ledger upsert keyed by the summary's cycle.
 *   2. offline `rate-daily` CLEAR replay — ledger delete keyed by the summary's cycle.
 *   3. updateHighlightStatsAfterRating — the "two adjacent lows" archive rule
 *      fires across the boundary regardless of which side is rated second, and
 *      does NOT fire when both lows fall inside one multi-month cycle.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cycleKeyForDate } from '@/lib/cycle'
import { updateHighlightStatsAfterRating } from '@/lib/highlightStats'

const state = vi.hoisted(() => ({ queue: [] as any[], freq: 1 }))

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => state.queue.slice()),
  removeAction: vi.fn(async (id: number) => {
    state.queue = state.queue.filter((a) => a.id !== id)
  }),
  incrementActionAttempts: vi.fn(async () => 1),
  rememberUserId: vi.fn(),
}))

vi.mock('@/lib/offlineStore', () => offlineMocks)
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))
vi.mock('@/lib/removeFromFutureMonths', () => ({ removeFromFutureMonths: vi.fn(async () => {}) }))
vi.mock('@/lib/cycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cycle')>()
  return { ...actual, getUserFrequency: vi.fn(async () => state.freq) }
})

import { replayPendingActions } from '@/lib/offlineReplay'

// ─── Supabase stub ──────────────────────────────────────────────────────────
// Records every highlight_months_reviewed upsert (month_year) and delete
// (.eq filters). daily_summary_highlights / daily_summaries reads resolve to
// the data supplied per table so removeReviewedOnClear and the stats routine
// see a controlled world.

type Low = { rating: 'low' | 'med' | 'high'; date: string }

function makeSupabase(opts: {
  rows?: Low[] // daily_summary_highlights rows for the highlight (with dates)
  highlight?: { unarchived_at?: string | null; archived?: boolean }
  summaries?: Array<{ id: string }> // daily_summaries in the cycle window (for clear)
  remainingRated?: Array<{ id: string }> // other rated rows still in the cycle (for clear)
}) {
  const rows = opts.rows ?? []
  const ledgerUpserts: string[] = []
  const ledgerDeletes: Record<string, unknown>[] = []
  const highlightUpdates: any[] = []

  const chain = (table: string): any => {
    let lowOnly = false
    let deleting = false
    let deleteFilters: Record<string, unknown> = {}
    const q: any = {
      select: () => q,
      update: (patch: any) => {
        if (table === 'highlights') highlightUpdates.push(patch)
        return q
      },
      upsert: (rowsIn: any) => {
        const arr = Array.isArray(rowsIn) ? rowsIn : [rowsIn]
        for (const r of arr) if (r && r.month_year) ledgerUpserts.push(r.month_year)
        return q
      },
      delete: () => {
        deleting = true
        return q
      },
      eq: (col: string, val: unknown) => {
        if (table === 'daily_summary_highlights' && col === 'rating' && val === 'low') lowOnly = true
        if (deleting) deleteFilters = { ...deleteFilters, [col]: val }
        return q
      },
      or: () => q,
      not: () => q,
      in: () => q,
      is: () => q,
      gte: () => q,
      lte: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      then: (r: any) => {
        if (deleting && table === 'highlight_months_reviewed') ledgerDeletes.push(deleteFilters)
        return r(resolve())
      },
    }
    const resolve = () => {
      if (table === 'highlights') {
        return {
          data: { unarchived_at: opts.highlight?.unarchived_at ?? null, archived: opts.highlight?.archived ?? false },
          error: null,
        }
      }
      if (table === 'daily_summaries') return { data: opts.summaries ?? [], error: null }
      if (table === 'daily_summary_highlights') {
        if (lowOnly) {
          return {
            data: rows.filter((r) => r.rating === 'low').map((r) => ({ rating: r.rating, daily_summary: { date: r.date } })),
            error: null,
          }
        }
        // applySummaryHighlightRating's update().select() and the all-ratings
        // read both land here; a non-empty array keeps the write "applied".
        // removeReviewedOnClear's "other rated rows remain?" read also lands
        // here — it is the only daily_summary_highlights read that uses .in().
        return { data: (opts.remainingRated ?? rows.map((r) => ({ rating: r.rating, id: 'x' }))) as any, error: null }
      }
      return { data: [], error: null }
    }
    return q
  }

  const supabase = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (table: string) => chain(table),
  } as any
  return { supabase, ledgerUpserts, ledgerDeletes, highlightUpdates }
}

beforeEach(() => {
  state.queue = []
  state.freq = 1
  offlineMocks.removeAction.mockClear()
})

// ─── 1 + 2. rate-daily replay across the boundary ───────────────────────────

describe('rate-daily replay: rating last cycle\'s day after the new cycle began', () => {
  const cases: Array<{ summaryDate: string; freq: number; expectedKey: string; label: string }> = [
    { summaryDate: '2026-10-31', freq: 1, expectedKey: '2026-10', label: 'Oct 31 rated on Nov 1 (monthly)' },
    { summaryDate: '2026-12-31', freq: 1, expectedKey: '2026-12', label: 'Dec 31 rated on Jan 1 (monthly, year rollover)' },
    { summaryDate: '2026-10-31', freq: 2, expectedKey: '2026-09', label: 'Oct 31 rated on Nov 1 (bimonthly: Sep–Oct)' },
    { summaryDate: '2026-12-31', freq: 12, expectedKey: '2026-01', label: 'Dec 31 rated on Jan 1 (yearly)' },
  ]

  for (const c of cases) {
    it(`${c.label} → ledger upsert keyed ${c.expectedKey}`, async () => {
      state.freq = c.freq
      const { supabase, ledgerUpserts } = makeSupabase({ rows: [{ rating: 'med', date: c.summaryDate }] })
      state.queue = [
        {
          id: 1,
          type: 'rate-daily',
          params: { summaryHighlightId: 'sh1', highlightId: 'h1', rating: 'med', summaryDate: c.summaryDate, ratedAt: 1 },
          createdAt: 1,
        },
      ]
      await replayPendingActions(supabase)
      expect(ledgerUpserts).toEqual([c.expectedKey])
      expect(cycleKeyForDate(c.summaryDate, c.freq)).toBe(c.expectedKey)
      expect(offlineMocks.removeAction).toHaveBeenCalledWith(1)
    })

    it(`${c.label} → CLEAR deletes the ${c.expectedKey} ledger row, not the current cycle's`, async () => {
      state.freq = c.freq
      const { supabase, ledgerUpserts, ledgerDeletes } = makeSupabase({
        rows: [],
        summaries: [{ id: 's-old' }],
        remainingRated: [], // no other rated day left in that cycle → checkmark must go
      })
      state.queue = [
        {
          id: 2,
          type: 'rate-daily',
          params: { summaryHighlightId: 'sh1', highlightId: 'h1', rating: null, summaryDate: c.summaryDate, ratedAt: 2, overwrite: true },
          createdAt: 2,
        },
      ]
      await replayPendingActions(supabase)
      expect(ledgerUpserts).toEqual([])
      expect(ledgerDeletes).toEqual([{ highlight_id: 'h1', month_year: c.expectedKey }])
      expect(offlineMocks.removeAction).toHaveBeenCalledWith(2)
    })
  }
})

// ─── 3. auto-archive across the boundary ────────────────────────────────────

describe('two-adjacent-lows archive rule across a cycle boundary', () => {
  it('monthly: Oct low + Nov low archives when the OLD (Oct) day is rated second', async () => {
    const { supabase, highlightUpdates } = makeSupabase({
      rows: [
        { rating: 'low', date: '2026-11-02' }, // rated first, in the new cycle
        { rating: 'low', date: '2026-10-30' }, // catch-up rating, in the old cycle
      ],
    })
    const res = await updateHighlightStatsAfterRating(supabase, { highlightId: 'h1', ratingDate: '2026-10-30', freq: 1 })
    expect(res.archivedNow).toBe(true)
    expect(highlightUpdates.at(-1)).toMatchObject({ archived: true, rating_count: 2 })
  })

  it('monthly: Dec low + Jan low archives across the year boundary (either order)', async () => {
    for (const ratingDate of ['2026-12-31', '2027-01-01']) {
      const { supabase } = makeSupabase({
        rows: [
          { rating: 'low', date: '2026-12-31' },
          { rating: 'low', date: '2027-01-01' },
        ],
      })
      const res = await updateHighlightStatsAfterRating(supabase, { highlightId: 'h1', ratingDate, freq: 1 })
      expect(res.archivedNow).toBe(true)
    }
  })

  it('quarterly: Oct 31 and Nov 1 are the SAME cycle, so two lows there do not archive', async () => {
    const { supabase, highlightUpdates } = makeSupabase({
      rows: [
        { rating: 'low', date: '2026-10-31' },
        { rating: 'low', date: '2026-11-01' },
      ],
    })
    const res = await updateHighlightStatsAfterRating(supabase, { highlightId: 'h1', ratingDate: '2026-10-31', freq: 3 })
    expect(res.archivedNow).toBe(false)
    expect(highlightUpdates.at(-1)).not.toHaveProperty('archived')
  })

  it('quarterly: Sep (Q3) low + Oct (Q4) low rated in the OLD quarter archives', async () => {
    const { supabase } = makeSupabase({
      rows: [
        { rating: 'low', date: '2026-10-05' },
        { rating: 'low', date: '2026-09-28' },
      ],
    })
    const res = await updateHighlightStatsAfterRating(supabase, { highlightId: 'h1', ratingDate: '2026-09-28', freq: 3 })
    expect(res.archivedNow).toBe(true)
  })

  it('monthly: a low in Oct and a low in Dec (not adjacent) does not archive', async () => {
    const { supabase } = makeSupabase({
      rows: [
        { rating: 'low', date: '2026-10-15' },
        { rating: 'low', date: '2026-12-15' },
      ],
    })
    const res = await updateHighlightStatsAfterRating(supabase, { highlightId: 'h1', ratingDate: '2026-10-15', freq: 1 })
    expect(res.archivedNow).toBe(false)
  })
})
