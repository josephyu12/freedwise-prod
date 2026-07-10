import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getCycleForDate,
  getUserReviewSettings,
  normalizeFreq,
  nextCycle,
  cycleSeed,
} from '@/lib/cycle'
import { Scored, DayBucket, packIntoDates } from '@/lib/binPack'
import { computeToDoLayout } from '@/lib/retile'

// Mirror /api/daily/prepare-next-cycle: it portions the NEXT cycle once today is
// within this many days of the current cycle's end (e.g. past the 24th of a
// 31-day month). A cadence change must honor the same window so the upcoming
// cycle isn't dropped.
const LEAD_DAYS = 7
const daysBetween = (aIso: string, bIso: string): number =>
  Math.round(
    (new Date(`${bIso}T00:00:00Z`).getTime() - new Date(`${aIso}T00:00:00Z`).getTime()) / 86400000
  )

/**
 * POST /api/daily/apply-frequency
 * Body { frequency: number, localDate?: string }
 *
 * Re-tiles the user's schedule onto a new review cadence. ONE unified operation
 * for every change (grow or shrink) — the direction falls out of which cycle
 * `today` lands in. See REVIEW_FREQUENCY_PLAN.md (anchored/reversible model).
 *
 * MODEL — rated rows are immutable anchors:
 *   • A rated daily_summary_highlights row is NEVER moved or deleted here. It is
 *     the permanent record of a review and its date is the truth.
 *   • A highlight is "done for the new cycle" iff it has a rated row dated inside
 *     the cycle. (When GROWING, this is the duplicate check: a highlight that was
 *     still to-do in the current month but was already reviewed in another month
 *     of the larger cycle is found here and stays done — never re-queued.)
 *   • Only UNRATED (to-do) rows are recomputed: cleared, then the unreviewed
 *     remainder is packed deterministically across [today … cycle end].
 *
 * Because every input to the pack (the unreviewed set, the day range, the fixed
 * cycleSeed, and the per-day load seeded from immutable rated rows) is a pure
 * function of the cycle + immutable history + today, switching back and forth
 * reproduces the exact same layout (reversible) and nothing is ever lost.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let frequency = 1
    let localDate: string | null = null
    try {
      const body = await request.json().catch(() => ({}))
      frequency = normalizeFreq((body as { frequency?: number }).frequency)
      if (typeof (body as { localDate?: unknown }).localDate === 'string') {
        localDate = (body as { localDate: string }).localDate
      }
    } catch {
      /* defaults */
    }

    // Keep the on/off flag; only the frequency changes here.
    const { enabled } = await getUserReviewSettings(supabase, user.id)

    const now = new Date()
    const today = localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)
      ? localDate
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    // The new frequency is persisted inside the retile_schedule RPC below, in
    // the same transaction as the re-tile — a half-applied cadence change is
    // no longer possible.
    const newCycle = getCycleForDate(today, frequency)
    const PAGE = 1000

    // Load active highlights once (id + stored score — see migration_highlight_score.sql).
    let allHighlightsData: Array<{ id: string; score: number }> = []
    {
      let from = 0
      while (true) {
        const { data, error } = await supabase
          .from('highlights')
          .select('id, score')
          .eq('user_id', user.id)
          .eq('archived', false)
          .range(from, from + PAGE - 1)
        if (error) throw error
        const page = (data || []) as Array<{ id: string; score: number }>
        allHighlightsData = allHighlightsData.concat(page)
        if (page.length < PAGE) break
        from += PAGE
      }
    }
    const scoreById = new Map<string, number>(allHighlightsData.map((h) => [h.id, h.score]))

    // ALL of the user's summaries (paginated). We need the full set because a
    // re-tile must clear EVERY unrated (to-do) row, not just those inside the new
    // cycle: a previous, larger cycle may have scattered to-do rows into months
    // that now fall outside the (smaller) cycle, and those must not linger or
    // double-place.
    let allSummaries: Array<{ id: string; date: string }> = []
    {
      let from = 0
      while (true) {
        const { data, error } = await supabase
          .from('daily_summaries')
          .select('id, date')
          .eq('user_id', user.id)
          .range(from, from + PAGE - 1)
        if (error) throw error
        const page = (data || []) as Array<{ id: string; date: string }>
        allSummaries = allSummaries.concat(page)
        if (page.length < PAGE) break
        from += PAGE
      }
    }
    // Subset inside the new cycle (used for the done-gate + per-day rated load).
    const cycleSummaries = allSummaries.filter((s) => s.date >= newCycle.startDate && s.date <= newCycle.endDate)
    const cycleSummaryIds = cycleSummaries.map((s) => s.id)
    const dateById = new Map(cycleSummaries.map((s) => [s.id, s.date]))

    // 2/3. doneIds = highlights with a RATED row dated anywhere in the cycle
    //      (the cross-month duplicate check), plus per-day rated load for balance.
    const doneIds = new Set<string>()
    const ratedScoreByDate = new Map<string, number>()
    if (cycleSummaryIds.length > 0) {
      let aFrom = 0
      while (true) {
        const { data: aPage, error: aErr } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id, daily_summary_id, rating')
          .in('daily_summary_id', cycleSummaryIds)
          .not('rating', 'is', null)
          .range(aFrom, aFrom + PAGE - 1)
        if (aErr) throw aErr
        const page = (aPage || []) as Array<{ highlight_id: string; daily_summary_id: string }>
        for (const a of page) {
          doneIds.add(a.highlight_id)
          const d = dateById.get(a.daily_summary_id)
          if (d) ratedScoreByDate.set(d, (ratedScoreByDate.get(d) ?? 0) + (scoreById.get(a.highlight_id) ?? 0))
        }
        if (page.length < PAGE) break
        aFrom += PAGE
      }
    }

    // 4. The reviewed ledgers to rebuild (the RPC diffs each key to exactly
    //    these ids, preserving surviving rows' created_at). The clearing of
    //    unrated rows + empty summaries (old steps 4-5, previously dozens of
    //    sequential requests with partial-failure windows) now happens inside
    //    the retile_schedule transaction.
    const ledgers: Array<{ month_year: string; highlight_ids: string[] }> = [
      { month_year: newCycle.key, highlight_ids: [...doneIds] },
    ]

    // 6/7. Pack the unreviewed remainder across [today … cycle end], balancing
    //      per-day TOTAL by seeding each pack day with its rated load. (Pure,
    //      reversible — see lib/retile.ts.)
    const highlights: Scored[] = allHighlightsData.map((h) => ({ id: h.id, score: h.score }))
    const buckets = computeToDoLayout({
      today,
      cycle: newCycle,
      highlights,
      doneIds,
      ratedScoreByDate,
    })

    // 7b. NEXT-CYCLE CARRY-OVER. When today is within the lead window of the new
    //     cycle's end, the daily cron (/api/daily/prepare-next-cycle) would have
    //     already portioned the NEXT cycle. Step 5 cleared EVERY unrated row
    //     library-wide — including those next-cycle to-do rows — so without this a
    //     cadence change made "past the 24th" silently drops the upcoming cycle.
    //     Re-portion it here for the new cadence, mirroring that cron's gating and
    //     packing: the FULL next-cycle dates (today is not in it), cycleSeed(next)
    //     for a reversible layout, done-gated by immutable rated rows.
    let nextBuckets: DayBucket[] = []
    let nextCycleKey: string | null = null
    if (enabled && daysBetween(today, newCycle.endDate) <= LEAD_DAYS) {
      const next = nextCycle(newCycle)
      nextCycleKey = next.key
      const nextSummaries = allSummaries.filter((s) => s.date >= next.startDate && s.date <= next.endDate)
      const nextSummaryIds = nextSummaries.map((s) => s.id)
      const nextDateById = new Map(nextSummaries.map((s) => [s.id, s.date]))

      // done-gate for the next cycle: highlights with a RATED row dated inside it,
      // plus per-day rated load for balance (identical model to steps 2/3).
      const nextDoneIds = new Set<string>()
      const nextRatedScoreByDate = new Map<string, number>()
      if (nextSummaryIds.length > 0) {
        let aFrom = 0
        while (true) {
          const { data: aPage, error: aErr } = await supabase
            .from('daily_summary_highlights')
            .select('highlight_id, daily_summary_id, rating')
            .in('daily_summary_id', nextSummaryIds)
            .not('rating', 'is', null)
            .range(aFrom, aFrom + PAGE - 1)
          if (aErr) throw aErr
          const page = (aPage || []) as Array<{ highlight_id: string; daily_summary_id: string }>
          for (const a of page) {
            nextDoneIds.add(a.highlight_id)
            const d = nextDateById.get(a.daily_summary_id)
            if (d) nextRatedScoreByDate.set(d, (nextRatedScoreByDate.get(d) ?? 0) + (scoreById.get(a.highlight_id) ?? 0))
          }
          if (page.length < PAGE) break
          aFrom += PAGE
        }
      }

      // The next cycle's ledger is rebuilt in the same RPC transaction.
      ledgers.push({ month_year: next.key, highlight_ids: [...nextDoneIds] })

      const nextUnreviewed = highlights.filter((h) => !nextDoneIds.has(h.id))
      const nextInitial = new Map<string, number>()
      for (const d of next.dates) nextInitial.set(d, nextRatedScoreByDate.get(d) ?? 0)
      nextBuckets = packIntoDates(nextUnreviewed, next.dates, cycleSeed(next), nextInitial)
    }

    // 5-8. Apply EVERYTHING in one transaction (see migration_schedule_rpcs.sql):
    //    persist the frequency, rebuild the ledgers, clear every unrated row
    //    library-wide, drop empty summaries, and insert the new layout (current
    //    cycle + next-cycle carry-over). The old sequence was dozens of
    //    independent requests — a timeout after the clear left empty days until
    //    a manual re-run. Now it fully applies or fully rolls back.
    const allBuckets = [...buckets, ...nextBuckets].filter((b) => b.highlights.length > 0)
    const { error: rpcError } = await (supabase.rpc as any)('retile_schedule', {
      p_frequency: frequency,
      p_ledgers: ledgers,
      p_buckets: allBuckets.map((b) => ({
        date: b.date,
        highlight_ids: b.highlights.map((h) => h.id),
      })),
    })
    if (rpcError) throw rpcError
    const packed = allBuckets.reduce((n, b) => n + b.highlights.length, 0)

    return NextResponse.json({
      message: `Applied frequency ${frequency}. Re-tiled cycle ${newCycle.key}.`,
      frequency,
      enabled,
      cycleKey: newCycle.key,
      doneCount: doneIds.size,
      repacked: packed,
      nextCycleKey,
    })
  } catch (error: any) {
    console.error('Error applying frequency:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to apply frequency' },
      { status: 500 }
    )
  }
}
