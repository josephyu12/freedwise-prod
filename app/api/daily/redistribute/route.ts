import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCycleForDate, nextCycle, cycleSeed, getUserReviewSettings, Cycle } from '@/lib/cycle'
import { packIntoDates, seededShuffle, hashStr, Scored } from '@/lib/binPack'

const FUTURE_CYCLE_CAP = 3

/**
 * POST /api/daily/redistribute
 * Assigns specific new highlights to the remaining days of the current review
 * cycle (and into any already-portioned future cycles). Existing assignments are
 * never removed or moved. Normally only affects days strictly after today; on a
 * fresh start (no summaries yet this cycle) or the last day of the cycle, today
 * is included.
 *
 * Body { highlightIds?: string[], debugLastDay?: boolean, localDate?: string }.
 * Highlights are only placed when highlightIds is provided (add-highlight flow)
 * or, on the last day of the cycle, for orphans (never assigned this cycle).
 *
 * No-op when daily review is OFF.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let requestedHighlightIds: string[] = []
    let debugLastDay = false
    let clientLocalDate: string | null = null
    try {
      const body = await request.json().catch(() => ({}))
      if (Array.isArray((body as { highlightIds?: unknown }).highlightIds)) {
        requestedHighlightIds = (body as { highlightIds: string[] }).highlightIds
      }
      if ((body as { debugLastDay?: boolean }).debugLastDay === true) debugLastDay = true
      if (typeof (body as { localDate?: unknown }).localDate === 'string') {
        clientLocalDate = (body as { localDate: string }).localDate
      }
    } catch {
      /* ignore */
    }

    const { freq, enabled } = await getUserReviewSettings(supabase, user.id)
    // Daily review off: a disabled user's new highlights must not be placed anywhere.
    if (!enabled) {
      return NextResponse.json({ message: 'Daily review is off — skipping redistribution', disabled: true })
    }

    let today: string
    if (clientLocalDate && /^\d{4}-\d{2}-\d{2}$/.test(clientLocalDate)) {
      today = clientLocalDate
    } else {
      const now = new Date()
      today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    }

    const cycle = getCycleForDate(today, freq)
    if (debugLastDay) today = cycle.endDate // pretend it's the last day of the cycle

    const PAGE = 1000

    // Fresh start = no daily summaries at all for this cycle yet.
    const { data: cycleSummaryRows } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('date', cycle.startDate)
      .lte('date', cycle.endDate)
      .limit(1)
    const isFreshStart = !cycleSummaryRows || cycleSummaryRows.length === 0

    const isLastDayOfCycle = today === cycle.endDate
    const remainingDates =
      isLastDayOfCycle || isFreshStart
        ? cycle.dates.filter((d) => d >= today)
        : cycle.dates.filter((d) => d > today)

    if (remainingDates.length === 0) {
      return NextResponse.json({ message: 'No remaining days in cycle - skipping redistribution', skipped: true })
    }

    // Future cycles already portioned out (have at least one summary). Walk
    // forward, breaking at the first cycle with no summaries.
    const futureCycles: Cycle[] = []
    let fc = nextCycle(cycle)
    for (let i = 0; i < FUTURE_CYCLE_CAP; i++) {
      const { data: fcSummaries } = await supabase
        .from('daily_summaries')
        .select('id')
        .eq('user_id', user.id)
        .gte('date', fc.startDate)
        .lte('date', fc.endDate)
        .limit(1)
      if (fcSummaries && fcSummaries.length > 0) {
        futureCycles.push(fc)
        fc = nextCycle(fc)
      } else {
        break
      }
    }

    // All unarchived highlights (paginate).
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

    // Reviewed-this-cycle (ledger), paginate.
    const reviewedHighlightIds = new Set<string>()
    let revFrom = 0
    while (true) {
      const { data: reviewedPage, error: reviewedError } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', cycle.key)
        .range(revFrom, revFrom + PAGE - 1)
      if (reviewedError) throw reviewedError
      const page = (reviewedPage || []) as Array<{ highlight_id: string }>
      for (const r of page) reviewedHighlightIds.add(r.highlight_id)
      if (page.length < PAGE) break
      revFrom += PAGE
    }

    // Existing summaries/assignments in the cycle window.
    const { data: existingSummaries, error: existingError } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('user_id', user.id)
      .gte('date', cycle.startDate)
      .lte('date', cycle.endDate)
    if (existingError) throw existingError
    const typedSummaries = (existingSummaries || []) as Array<{ id: string; date: string }>

    const reviewedHighlightIdsFromRatings = new Set<string>()
    const completedDays = new Set<string>()
    const assignedThisCycleIds = new Set<string>()
    const allAssignments: Array<{ highlight_id: string; daily_summary_id: string }> = []

    if (typedSummaries.length > 0) {
      const summaryIds = typedSummaries.map((s) => s.id)
      let assignments: Array<{ highlight_id: string; daily_summary_id: string; rating: number | null }> = []
      let aFrom = 0
      while (true) {
        const { data: aPage, error: aErr } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id, daily_summary_id, rating')
          .in('daily_summary_id', summaryIds)
          .range(aFrom, aFrom + PAGE - 1)
        if (aErr) throw aErr
        const page = (aPage || []) as Array<{ highlight_id: string; daily_summary_id: string; rating: number | null }>
        assignments = assignments.concat(page)
        if (page.length < PAGE) break
        aFrom += PAGE
      }

      for (const a of assignments) {
        assignedThisCycleIds.add(a.highlight_id)
        allAssignments.push({ highlight_id: a.highlight_id, daily_summary_id: a.daily_summary_id })
        if (a.rating !== null) reviewedHighlightIdsFromRatings.add(a.highlight_id)
      }

      const byDate = new Map<string, Array<{ rating: number | null }>>()
      for (const a of assignments) {
        const summary = typedSummaries.find((s) => s.id === a.daily_summary_id)
        if (!summary) continue
        if (!byDate.has(summary.date)) byDate.set(summary.date, [])
        byDate.get(summary.date)!.push({ rating: a.rating })
      }
      for (const [date, arr] of byDate.entries()) {
        const total = arr.length
        const rated = arr.filter((a) => a.rating !== null).length
        if (total > 0 && rated === total) completedDays.add(date)
      }
    }

    let allHighlights = allHighlightsData.filter(
      (h) => !reviewedHighlightIds.has(h.id) && !reviewedHighlightIdsFromRatings.has(h.id)
    )

    // If the client sent specific highlightIds we don't see in the bulk fetch, fetch them.
    if (requestedHighlightIds.length > 0) {
      const inAll = new Set(allHighlights.map((h) => h.id))
      const missing = requestedHighlightIds.filter((id) => !inAll.has(id))
      if (missing.length > 0) {
        const { data: requestedData } = await supabase
          .from('highlights')
          .select('id, text, html_content')
          .eq('user_id', user.id)
          .eq('archived', false)
          .in('id', missing)
        if (requestedData && requestedData.length > 0) {
          const requested = (requestedData as Array<{ id: string; text: string; html_content: string | null }>)
            .filter((h) => !reviewedHighlightIds.has(h.id) && !reviewedHighlightIdsFromRatings.has(h.id))
          const byId = new Map([...allHighlights, ...requested].map((h) => [h.id, h]))
          allHighlights = Array.from(byId.values())
        }
      }
    }

    if (allHighlights.length === 0) {
      return NextResponse.json({ message: 'No highlights to redistribute' })
    }

    const allScored: Scored[] = allHighlights.map((h) => {
      const content = h.html_content || h.text || ''
      return { id: h.id, text: h.text, html_content: h.html_content, score: content.replace(/<[^>]*>/g, '').length }
    })
    // Per-day weight (dayState below) must reflect the TRUE reading load of every
    // highlight actually sitting on a day — so score EVERY unarchived highlight,
    // not just the `allHighlights` subset. `allHighlights` drops rows in the
    // reviewed ledger (reviewedHighlightIds) and rated rows; scoring the day off
    // that subset zeroed them out, so a day holding a ledger-flagged highlight
    // (e.g. a very long one whose assignment is still unrated) looked empty and
    // became a magnet — a newly-added highlight landed on Aug 15, the single
    // HEAVIEST day, because its 11.5k-char highlight scored 0. Weighting by the
    // full per-day total matches apply-frequency / prepare-next-cycle's model.
    const idToScore = new Map(
      allHighlightsData.map((h) => {
        const content = h.html_content || h.text || ''
        return [h.id, content.replace(/<[^>]*>/g, '').length] as const
      })
    )

    // Which highlights to actually place this cycle: requested-and-not-yet-assigned,
    // plus (on the last day) any orphans never assigned this cycle.
    const requestedSet = requestedHighlightIds.length > 0 ? new Set(requestedHighlightIds) : null
    let toPlace: Scored[] = requestedSet
      ? allScored.filter((h) => requestedSet.has(h.id) && !assignedThisCycleIds.has(h.id))
      : []
    if (isLastDayOfCycle) {
      const orphanById = new Map(allScored.filter((h) => !assignedThisCycleIds.has(h.id)).map((h) => [h.id, h]))
      for (const h of toPlace) orphanById.set(h.id, h)
      toPlace = Array.from(orphanById.values())
    }
    {
      const byId = new Map(toPlace.map((h) => [h.id, h]))
      toPlace = Array.from(byId.values())
    }

    const createdAssignments: any[] = []
    const seed = cycleSeed(cycle)

    if (toPlace.length > 0) {
      const openRemaining = remainingDates.filter((d) => !completedDays.has(d))

      if (openRemaining.length === 0) {
        // All remaining days fully done: add to the last day only.
        const lastDate = cycle.endDate
        let lastSummary = typedSummaries.find((s) => s.date === lastDate)
        if (!lastSummary) {
          const { data: newSummary, error: sErr } = await (supabase.from('daily_summaries') as any)
            .insert([{ date: lastDate, user_id: user.id }])
            .select()
            .single()
          if (sErr) throw sErr
          lastSummary = newSummary
        }
        if (lastSummary) {
          const { error: linkError } = await (supabase.from('daily_summary_highlights') as any)
            .upsert(
              toPlace.map((h) => ({ daily_summary_id: lastSummary!.id, highlight_id: h.id })),
              { onConflict: 'daily_summary_id,highlight_id', ignoreDuplicates: true }
            )
          if (linkError) throw linkError
          createdAssignments.push({ date: lastDate, highlightCount: toPlace.length })
        }
      } else {
        // Balance onto the open remaining days, accounting for existing per-day scores.
        const dayState = openRemaining.map((date) => {
          const summary = typedSummaries.find((s) => s.date === date)
          let totalScore = 0
          if (summary) {
            for (const a of allAssignments) {
              if (a.daily_summary_id === summary.id) totalScore += idToScore.get(a.highlight_id) ?? 0
            }
          }
          return { date, summaryId: summary?.id ?? null, totalScore }
        })

        const sorted = [...seededShuffle(toPlace, seed)].sort((a, b) => b.score - a.score)
        for (const h of sorted) {
          let minScore = dayState[0].totalScore
          for (let i = 1; i < dayState.length; i++) if (dayState[i].totalScore < minScore) minScore = dayState[i].totalScore
          const tied = dayState.map((_, i) => i).filter((i) => dayState[i].totalScore === minScore)
          let idx = tied[0]
          if (tied.length > 1) {
            let r = (seed + hashStr(h.id)) >>> 0
            const rand = () => { r = (r * 9301 + 49297) % 233280; return r / 233280 }
            idx = tied[Math.floor(rand() * tied.length)]
          }
          const slot = dayState[idx]
          if (!slot.summaryId) {
            const { data: summaryData, error: sErr } = await (supabase.from('daily_summaries') as any)
              .insert([{ date: slot.date, user_id: user.id }])
              .select()
              .single()
            if (sErr) throw sErr
            slot.summaryId = summaryData.id
          }
          const { error: linkError } = await (supabase.from('daily_summary_highlights') as any)
            .upsert(
              [{ daily_summary_id: slot.summaryId, highlight_id: h.id }],
              { onConflict: 'daily_summary_id,highlight_id', ignoreDuplicates: true }
            )
          if (linkError) throw linkError
          slot.totalScore += h.score
          createdAssignments.push({ date: slot.date, highlightCount: 1 })
        }
      }
    }

    // Assign into already-portioned future cycles.
    const futureCycleAssignments: any[] = []
    for (const future of futureCycles) {
      if (toPlace.length === 0) break

      // Dedup against the future cycle's reviewed ledger + any rated assignments.
      const fcReviewed = new Set<string>()
      const { data: fcReviewedData } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', future.key)
      for (const r of (fcReviewedData || []) as Array<{ highlight_id: string }>) fcReviewed.add(r.highlight_id)

      const { data: fcSummaries } = await supabase
        .from('daily_summaries')
        .select('id, date')
        .eq('user_id', user.id)
        .gte('date', future.startDate)
        .lte('date', future.endDate)
      const fcTypedSummaries = (fcSummaries || []) as Array<{ id: string; date: string }>
      if (fcTypedSummaries.length > 0) {
        const { data: fcRated } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id')
          .in('daily_summary_id', fcTypedSummaries.map((s) => s.id))
          .not('rating', 'is', null)
        for (const a of (fcRated || []) as Array<{ highlight_id: string }>) fcReviewed.add(a.highlight_id)
      }

      const forFuture = toPlace.filter((h) => !fcReviewed.has(h.id))
      if (forFuture.length === 0) continue

      const buckets = packIntoDates(forFuture, future.dates, cycleSeed(future))
      for (const bucket of buckets) {
        if (bucket.highlights.length === 0) continue
        let summaryId: string | null = fcTypedSummaries.find((s) => s.date === bucket.date)?.id ?? null
        if (!summaryId) {
          const { data: summaryData, error: sErr } = await (supabase.from('daily_summaries') as any)
            .insert([{ date: bucket.date, user_id: user.id }])
            .select()
            .single()
          if (sErr) throw sErr
          summaryId = summaryData.id
        }
        const { error: linkError } = await (supabase.from('daily_summary_highlights') as any)
          .upsert(
            bucket.highlights.map((h) => ({ daily_summary_id: summaryId, highlight_id: h.id })),
            { onConflict: 'daily_summary_id,highlight_id', ignoreDuplicates: true }
          )
        if (linkError) throw linkError
        futureCycleAssignments.push({ date: bucket.date, highlightCount: bucket.highlights.length })
      }
    }

    return NextResponse.json({
      message: `Redistributed ${toPlace.length} highlights across the remaining days of cycle ${cycle.key}${futureCycles.length > 0 ? ` and ${futureCycles.length} future cycle(s)` : ''}`,
      assignments: createdAssignments,
      futureCycleAssignments,
      totalHighlights: toPlace.length,
      assignedToFutureCycles: futureCycles.length,
      ...(debugLastDay ? { debugLastDay: true, effectiveDate: today } : {}),
    })
  } catch (error: any) {
    console.error('Error redistributing highlights:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to redistribute highlights' },
      { status: 500 }
    )
  }
}
