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
    let allHighlightsData: Array<{ id: string; text: string; html_content: string | null }> = []
    let from = 0
    while (true) {
      const { data, error: pageError } = await supabase
        .from('highlights')
        .select('id, text, html_content')
        .eq('user_id', user.id)
        .eq('archived', false)
        .range(from, from + PAGE - 1)
      if (pageError) throw pageError
      const page = (data || []) as Array<{ id: string; text: string; html_content: string | null }>
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

    const highlightsWithScore: Scored[] = allHighlights.map((h) => {
      const content = h.html_content || h.text || ''
      const score = content.replace(/<[^>]*>/g, '').length
      return { id: h.id, text: h.text, html_content: h.html_content, score }
    })

    // Existing summaries in the cycle window (may span 2–12 calendar months).
    const { data: existingSummaries, error: existingError } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('user_id', user.id)
      .gte('date', cycle.startDate)
      .lte('date', cycle.endDate)
    if (existingError) throw existingError

    const typedSummaries = (existingSummaries || []) as Array<{ id: string; date: string }>

    // Identify completed days (all highlights rated) — preserve them untouched.
    const completedDays = new Set<string>()
    const preservedAssignments = new Map<string, { date: string; summaryId: string }>()
    const deletedSummaryIds = new Set<string>()

    if (typedSummaries.length > 0) {
      const summaryIds = typedSummaries.map((s) => s.id)

      let existingAssignments: Array<{ id: string; highlight_id: string; daily_summary_id: string; rating: number | null }> = []
      let aFrom = 0
      while (true) {
        const { data: aPage, error: assignmentsError } = await supabase
          .from('daily_summary_highlights')
          .select('id, highlight_id, daily_summary_id, rating')
          .in('daily_summary_id', summaryIds)
          .range(aFrom, aFrom + PAGE - 1)
        if (assignmentsError) throw assignmentsError
        const page = (aPage || []) as Array<{ id: string; highlight_id: string; daily_summary_id: string; rating: number | null }>
        existingAssignments = existingAssignments.concat(page)
        if (page.length < PAGE) break
        aFrom += PAGE
      }

      const assignmentsByDate = new Map<string, Array<{ highlight_id: string; rating: number | null }>>()
      for (const a of existingAssignments) {
        const summary = typedSummaries.find((s) => s.id === a.daily_summary_id)
        if (!summary) continue
        if (!assignmentsByDate.has(summary.date)) assignmentsByDate.set(summary.date, [])
        assignmentsByDate.get(summary.date)!.push({ highlight_id: a.highlight_id, rating: a.rating })
      }

      for (const [date, dateAssignments] of assignmentsByDate.entries()) {
        const total = dateAssignments.length
        const rated = dateAssignments.filter((a) => a.rating !== null).length
        if (total > 0 && rated === total) {
          completedDays.add(date)
          const summary = typedSummaries.find((s) => s.date === date)
          if (summary) {
            for (const a of dateAssignments) {
              preservedAssignments.set(a.highlight_id, { date: summary.date, summaryId: summary.id })
            }
          }
        }
      }

      // Delete assignments + summaries for non-completed days (recreated below).
      const summariesToModify = typedSummaries.filter((s) => !completedDays.has(s.date))
      const summaryIdsToModify = summariesToModify.map((s) => s.id)
      for (const id of summaryIdsToModify) deletedSummaryIds.add(id)
      if (summaryIdsToModify.length > 0) {
        await supabase.from('daily_summary_highlights').delete().in('daily_summary_id', summaryIdsToModify)
        await supabase.from('daily_summaries').delete().in('id', summaryIdsToModify)
      }
    }

    // Pack non-preserved highlights onto the days at/after fromDate. Prefer
    // not-yet-completed days so finished days aren't disturbed.
    const highlightsToAssign = highlightsWithScore.filter((h) => !preservedAssignments.has(h.id))
    let packDates = cycle.dates.filter((d) => d >= fromDate && !completedDays.has(d))
    // SAFETY NET: every unreviewed highlight MUST land somewhere. If all remaining
    // days are already "completed" — e.g. resuming after an off→on where clearing
    // future un-rated rows left each reviewed-ahead day holding only its rated
    // highlights — fall back to the full remaining window (re-opening those days by
    // appending the backlog), then to the last day. Without this, a backlog of
    // unreviewed highlights silently vanishes from the cycle.
    if (packDates.length === 0) packDates = cycle.dates.filter((d) => d >= fromDate)
    if (packDates.length === 0) packDates = [cycle.endDate]
    const buckets = highlightsToAssign.length > 0
      ? packIntoDates(highlightsToAssign, packDates, cycleSeed(cycle))
      : []

    const createdAssignments: any[] = []
    for (const bucket of buckets) {
      if (bucket.highlights.length === 0) continue

      let summaryId: string | null = null
      const existingSummary = typedSummaries.find((s) => s.date === bucket.date)
      if (existingSummary && !deletedSummaryIds.has(existingSummary.id)) {
        summaryId = existingSummary.id
      } else {
        const { data: summaryData, error: summaryError } = await (supabase
          .from('daily_summaries') as any)
          .insert([{ date: bucket.date, user_id: user.id }])
          .select()
          .single()
        if (summaryError) throw summaryError
        summaryId = summaryData.id
      }

      if (summaryId) {
        // Upsert (ignore duplicates): when the safety net appends a backlog onto an
        // existing (completed) day's summary, a highlight could already be linked.
        const { error: linkError } = await (supabase.from('daily_summary_highlights') as any)
          .upsert(
            bucket.highlights.map((h) => ({ daily_summary_id: summaryId, highlight_id: h.id })),
            { onConflict: 'daily_summary_id,highlight_id', ignoreDuplicates: true }
          )
        if (linkError) throw linkError
        createdAssignments.push({
          date: bucket.date,
          highlightCount: bucket.highlights.length,
          totalScore: bucket.totalScore,
        })
      }
    }

    const preservedCount = preservedAssignments.size
    const completedDaysCount = completedDays.size

    return NextResponse.json({
      message: `Assigned ${highlightsToAssign.length} highlights across the cycle (${cycle.key})${completedDaysCount > 0 ? ` (preserved ${completedDaysCount} completed days)` : ''}`,
      assignments: createdAssignments,
      cycleKey: cycle.key,
      totalHighlights: highlightsToAssign.length,
      preservedCount,
      completedDaysCount,
    })
  } catch (error: any) {
    console.error('Error assigning highlights to cycle:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to assign highlights' },
      { status: 500 }
    )
  }
}
