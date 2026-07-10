import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCycle, cycleSeed, getUserReviewSettings } from '@/lib/cycle'
import { packIntoDates, Scored } from '@/lib/binPack'

/**
 * POST /api/daily/assign
 * Assigns highlights to the days of the review CYCLE that contains { year, month }.
 * A cycle is N calendar-aligned months (N = the user's frequency_months); for the
 * default monthly cadence it is exactly one calendar month and behavior is
 * byte-identical to the pre-cycle implementation.
 *
 * Acts on the whole cycle by default (all days, past and future). Preserves
 * completed days (all highlights rated); recreates summaries for all other days.
 *
 * Body { year, month, fromDate? }. Pass `fromDate` (today's YYYY-MM-DD) when
 * building the current cycle for the first time mid-cycle, so highlights are
 * distributed only across remaining days (today → end of cycle) instead of
 * being wasted on days that have already passed. Omit it for a full-cycle build
 * (reset, next-cycle prep).
 *
 * If the user has daily review turned OFF, this is a no-op (returns disabled:true).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { year, month } = body

    if (!year || !month) {
      return NextResponse.json({ error: 'Year and month are required' }, { status: 400 })
    }
    if (month < 1 || month > 12) {
      return NextResponse.json({ error: 'Month must be between 1 and 12' }, { status: 400 })
    }

    const { freq, enabled } = await getUserReviewSettings(supabase, user.id)
    // Daily review off: never generate new assignments.
    if (!enabled) {
      return NextResponse.json({ assigned: 0, disabled: true, message: 'Daily review is off' })
    }

    const cycle = getCycle(year, month, freq)

    // Optional fromDate: limit distribution to cycle days >= fromDate (today → end
    // of cycle for a mid-cycle first build). Clamp into the cycle so a bad value
    // never zeroes out the cycle.
    let fromDate = cycle.startDate
    const rawFromDate = (body as { fromDate?: unknown }).fromDate
    if (typeof rawFromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawFromDate)) {
      if (rawFromDate > cycle.endDate) fromDate = cycle.endDate
      else if (rawFromDate < cycle.startDate) fromDate = cycle.startDate
      else fromDate = rawFromDate
    }

    const monthYear = cycle.key

    // Fetch ALL unarchived highlights (paginate past Supabase's 1000-row default).
    const PAGE = 1000
    let allHighlightsData: Array<{ id: string; score: number }> = []
    let from = 0
    while (true) {
      const { data, error: pageError } = await supabase
        .from('highlights')
        .select('id, score')
        .eq('user_id', user.id)
        .eq('archived', false)
        .range(from, from + PAGE - 1)
      if (pageError) throw pageError
      const page = (data || []) as Array<{ id: string; score: number }>
      allHighlightsData = allHighlightsData.concat(page)
      if (page.length < PAGE) break
      from += PAGE
    }

    // Highlights already reviewed for this cycle (paginate).
    const reviewedHighlightIds = new Set<string>()
    from = 0
    while (true) {
      const { data: reviewedPage, error: reviewedError } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', monthYear)
        .range(from, from + PAGE - 1)
      if (reviewedError) throw reviewedError
      const page = (reviewedPage || []) as Array<{ highlight_id: string }>
      for (const r of page) reviewedHighlightIds.add(r.highlight_id)
      if (page.length < PAGE) break
      from += PAGE
    }

    const allHighlights = allHighlightsData.filter((h) => !reviewedHighlightIds.has(h.id))

    if (allHighlights.length === 0) {
      return NextResponse.json({ message: 'No highlights to assign', assignments: [] })
    }

    const highlightsWithScore: Scored[] = allHighlights.map((h) => ({ id: h.id, score: h.score }))

    // Existing summaries in the cycle window (may span 2–12 calendar months).
    const { data: existingSummaries, error: existingError } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('user_id', user.id)
      .gte('date', cycle.startDate)
      .lte('date', cycle.endDate)
    if (existingError) throw existingError

    const typedSummaries = (existingSummaries || []) as Array<{ id: string; date: string }>
    const scoreById = new Map(highlightsWithScore.map((h) => [h.id, h.score]))

    // CRITICAL INVARIANT: a rated daily_summary_highlights row and its
    // highlight_months_reviewed (ledger) row are the permanent record of a review
    // and MUST move together. Only reset-cycle (an explicit user reset) removes
    // both. Every other path — including this one — must NEVER delete a rated row
    // on its own: doing so leaves the highlight flagged "reviewed" in the ledger
    // (so it's excluded from re-packing) yet present on no day, i.e. stranded /
    // invisible. This was the bug behind the off→on data loss and the empty days.
    //
    // So: load every RATED row (a) to leave it exactly in place and (b) to seed
    // per-day load for a balanced re-pack; then delete ONLY unrated rows.
    const ratedHighlightIds = new Set<string>()
    const ratedScoreByDate = new Map<string, number>()
    if (typedSummaries.length > 0) {
      const summaryIds = typedSummaries.map((s) => s.id)
      const dateById = new Map(typedSummaries.map((s) => [s.id, s.date]))

      let aFrom = 0
      while (true) {
        const { data: aPage, error: assignmentsError } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id, daily_summary_id, rating')
          .in('daily_summary_id', summaryIds)
          .not('rating', 'is', null)
          .range(aFrom, aFrom + PAGE - 1)
        if (assignmentsError) throw assignmentsError
        const page = (aPage || []) as Array<{ highlight_id: string; daily_summary_id: string }>
        for (const a of page) {
          ratedHighlightIds.add(a.highlight_id)
          const d = dateById.get(a.daily_summary_id)
          if (d) ratedScoreByDate.set(d, (ratedScoreByDate.get(d) ?? 0) + (scoreById.get(a.highlight_id) ?? 0))
        }
        if (page.length < PAGE) break
        aFrom += PAGE
      }
    }

    // Pack the unreviewed remainder onto the days at/after fromDate. Exclude
    // anything already rated this cycle (its row is preserved above) on top of the
    // ledger-reviewed exclusion already applied to highlightsWithScore — this also
    // self-heals any rated-without-ledger row by not double-placing it.
    const highlightsToAssign = highlightsWithScore.filter((h) => !ratedHighlightIds.has(h.id))
    let packDates = cycle.dates.filter((d) => d >= fromDate)
    if (packDates.length === 0) packDates = [cycle.endDate]
    // Seed each pack day with the score of the rated rows already on it, so days
    // that are partially/fully reviewed receive proportionally fewer new
    // highlights and the per-day TOTAL stays even (prevents the "one overloaded
    // day" symptom). For a clean build (no rated rows) all seeds are 0, so the
    // layout is byte-identical to the original packer.
    const initialLoads = new Map<string, number>()
    for (const d of packDates) initialLoads.set(d, ratedScoreByDate.get(d) ?? 0)

    const buckets = highlightsToAssign.length > 0
      ? packIntoDates(highlightsToAssign, packDates, cycleSeed(cycle), initialLoads)
      : []

    // ONE atomic RPC (see migration_schedule_rpcs.sql): clear the cycle's
    // unrated rows (rated rows stay put — no reviewed highlight can be
    // stranded; summaries are kept so days holding rated rows survive) and
    // apply the packed layout. Previously this was a delete followed by up to
    // 2 requests per day — a failure in between left the cycle half-cleared.
    const nonEmpty = buckets.filter((b) => b.highlights.length > 0)
    const { error: rpcError } = await (supabase.rpc as any)('assign_cycle_layout', {
      p_cycle_start: cycle.startDate,
      p_cycle_end: cycle.endDate,
      p_buckets: nonEmpty.map((b) => ({
        date: b.date,
        highlight_ids: b.highlights.map((h) => h.id),
      })),
    })
    if (rpcError) throw rpcError

    const createdAssignments = nonEmpty.map((b) => ({
      date: b.date,
      highlightCount: b.highlights.length,
      totalScore: b.totalScore,
    }))

    const preservedCount = ratedHighlightIds.size

    return NextResponse.json({
      message: `Assigned ${highlightsToAssign.length} highlights across the cycle (${cycle.key})${preservedCount > 0 ? ` (preserved ${preservedCount} rated highlights in place)` : ''}`,
      assignments: createdAssignments,
      cycleKey: cycle.key,
      totalHighlights: highlightsToAssign.length,
      preservedCount,
    })
  } catch (error: any) {
    console.error('Error assigning highlights to cycle:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to assign highlights' },
      { status: 500 }
    )
  }
}
