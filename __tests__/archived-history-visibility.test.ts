/**
 * Archived highlights keep their review history, but vanish from upcoming days.
 *
 *   1. removeFromFutureMonths deletes only UNRATED assignments dated today or
 *      later — never a rated row (that's history, kept on its day and shown
 *      badged Archived), and never anything before today.
 *   2. The two-lows auto-archive (updateHighlightStatsAfterRating) performs that
 *      deletion too, so a highlight the rule archives disappears from the rest
 *      of this cycle AND any pre-built next cycle it was already portioned to —
 *      and does so on shouldArchive, so a retry after the flag already flipped
 *      still clears the rows.
 *   3. isVisibleAssignment is the single rule the day view, calendar, and
 *      offline overlay share.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { removeFromFutureMonths } from '@/lib/removeFromFutureMonths'
import { updateHighlightStatsAfterRating } from '@/lib/highlightStats'
import { isVisibleAssignment } from '@/lib/monthReviewStatus'

// ─── Recording Supabase stub ────────────────────────────────────────────────

type Call = { table: string; op: string; filters: Array<[string, string, unknown]> }

function makeSupabase(opts: {
  futureSummaries?: Array<{ id: string }>
  lows?: string[] // dates of low ratings for the highlight
  archived?: boolean
  failDelete?: boolean
}) {
  const calls: Call[] = []
  const chain = (table: string): any => {
    const call: Call = { table, op: 'select', filters: [] }
    let lowOnly = false
    const q: any = {
      select: () => q,
      update: () => {
        call.op = 'update'
        return q
      },
      delete: () => {
        call.op = 'delete'
        return q
      },
      eq: (c: string, v: unknown) => {
        call.filters.push([c, 'eq', v])
        if (table === 'daily_summary_highlights' && c === 'rating' && v === 'low') lowOnly = true
        return q
      },
      is: (c: string, v: unknown) => {
        call.filters.push([c, 'is', v])
        return q
      },
      in: (c: string, v: unknown) => {
        call.filters.push([c, 'in', v])
        return q
      },
      gte: (c: string, v: unknown) => {
        call.filters.push([c, 'gte', v])
        return q
      },
      not: () => q,
      single: () => Promise.resolve(resolve()),
      then: (r: any) => {
        calls.push(call)
        return r(resolve())
      },
    }
    const resolve = () => {
      if (call.op === 'delete') return { data: null, error: opts.failDelete ? { code: '500', message: 'boom' } : null }
      if (table === 'daily_summaries') return { data: opts.futureSummaries ?? [], error: null }
      if (table === 'highlights') return { data: { unarchived_at: null, archived: opts.archived ?? false }, error: null }
      if (table === 'daily_summary_highlights') {
        const lows = (opts.lows ?? []).map((d) => ({ rating: 'low', daily_summary: { date: d } }))
        return { data: lowOnly ? lows : lows.map((l) => ({ rating: l.rating })), error: null }
      }
      return { data: [], error: null }
    }
    return q
  }
  return { supabase: { from: (t: string) => chain(t) } as any, calls }
}

const localToday = () => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

// ─── 1. removeFromFutureMonths ──────────────────────────────────────────────

describe('removeFromFutureMonths keeps rated history', () => {
  it('deletes only UNRATED rows dated today or later', async () => {
    const { supabase, calls } = makeSupabase({ futureSummaries: [{ id: 's-today' }, { id: 's-next-cycle' }] })
    await removeFromFutureMonths(supabase, 'h1')

    const read = calls.find((c) => c.table === 'daily_summaries')!
    expect(read.filters).toEqual([['date', 'gte', localToday()]])

    const del = calls.find((c) => c.table === 'daily_summary_highlights' && c.op === 'delete')!
    expect(del.filters).toEqual([
      ['highlight_id', 'eq', 'h1'],
      ['rating', 'is', null], // rated rows are history — never deleted
      ['daily_summary_id', 'in', ['s-today', 's-next-cycle']], // spans every pre-built cycle
    ])
  })

  it('does nothing when there are no assignments from today on', async () => {
    const { supabase, calls } = makeSupabase({ futureSummaries: [] })
    await removeFromFutureMonths(supabase, 'h1')
    expect(calls.some((c) => c.op === 'delete')).toBe(false)
  })

  it('throws on a failed delete so an offline replay keeps the action queued', async () => {
    const { supabase } = makeSupabase({ futureSummaries: [{ id: 's1' }], failDelete: true })
    await expect(removeFromFutureMonths(supabase, 'h1')).rejects.toBeTruthy()
  })
})

// ─── 2. auto-archive removes upcoming assignments ───────────────────────────

describe('two-lows auto-archive drops the highlight from upcoming days', () => {
  it('deletes unrated future assignments when the rule fires', async () => {
    const { supabase, calls } = makeSupabase({
      lows: ['2026-10-12', '2026-11-03'],
      futureSummaries: [{ id: 's-nov' }, { id: 's-dec' }],
    })
    const res = await updateHighlightStatsAfterRating(supabase, { highlightId: 'h1', ratingDate: '2026-11-03', freq: 1 })
    expect(res.archivedNow).toBe(true)

    const del = calls.find((c) => c.table === 'daily_summary_highlights' && c.op === 'delete')
    expect(del).toBeDefined()
    expect(del!.filters).toContainEqual(['rating', 'is', null])
    expect(del!.filters).toContainEqual(['daily_summary_id', 'in', ['s-nov', 's-dec']])
  })

  it('still clears the rows on a retry when the flag had already flipped', async () => {
    const { supabase, calls } = makeSupabase({
      lows: ['2026-10-12', '2026-11-03'],
      futureSummaries: [{ id: 's-nov' }],
      archived: true, // first attempt set the flag, then the delete failed
    })
    const res = await updateHighlightStatsAfterRating(supabase, { highlightId: 'h1', ratingDate: '2026-11-03', freq: 1 })
    expect(res.archivedNow).toBe(false) // not a new archive → no toast
    expect(calls.some((c) => c.table === 'daily_summary_highlights' && c.op === 'delete')).toBe(true)
  })

  it('touches no assignments when the rule does not fire', async () => {
    const { supabase, calls } = makeSupabase({ lows: ['2026-11-03'], futureSummaries: [{ id: 's-nov' }] })
    const res = await updateHighlightStatsAfterRating(supabase, { highlightId: 'h1', ratingDate: '2026-11-03', freq: 1 })
    expect(res.archivedNow).toBe(false)
    expect(calls.some((c) => c.op === 'delete')).toBe(false)
    expect(calls.some((c) => c.table === 'daily_summaries')).toBe(false)
  })
})

// ─── 3. the shared visibility rule ──────────────────────────────────────────

describe('isVisibleAssignment', () => {
  it('shows active rows whatever their rating', () => {
    expect(isVisibleAssignment({ rating: null, archived: false })).toBe(true)
    expect(isVisibleAssignment({ rating: 'high', archived: false })).toBe(true)
    expect(isVisibleAssignment({ rating: null })).toBe(true) // older cached rows without the flag
  })

  it('shows an archived row only when it was rated (history)', () => {
    expect(isVisibleAssignment({ rating: 'low', archived: true })).toBe(true)
    expect(isVisibleAssignment({ rating: null, archived: true })).toBe(false)
  })
})

// Pin the local-date convention used by removeFromFutureMonths: a US evening
// must still read as today, not UTC-tomorrow.
describe('removeFromFutureMonths uses the LOCAL date', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 23:30 local on Oct 31 — in UTC (for a negative offset) it is already Nov 1.
    vi.setSystemTime(new Date(2026, 9, 31, 23, 30, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('cuts off at local Oct 31, so an Oct 31 unrated row is still removed', async () => {
    const { supabase, calls } = makeSupabase({ futureSummaries: [{ id: 's' }] })
    await removeFromFutureMonths(supabase, 'h1')
    const read = calls.find((c) => c.table === 'daily_summaries')!
    expect(read.filters).toEqual([['date', 'gte', '2026-10-31']])
  })
})
