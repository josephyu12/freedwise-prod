import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/daily/redistribute
 * When a highlight is added: assigns only that new highlight (and any other unassigned
 * ones this month) to remaining days. Existing assignments are never removed or moved.
 * Only affects future days: strictly after today (tomorrow through end of month).
 * Today is never changed.
 *
 * - Only highlights that are not yet assigned to any day this month are placed.
 * - Partially-done days (some highlights rated): can receive new highlights.
 * - Fully-done days (all highlights rated): are left unchanged; new highlights are never
 *   added to them.
 * - If all remaining days are fully done, the new highlight(s) are assigned to the last
 *   day of the month only; that day becomes not-done.
 *
 * Also assigns new highlights to future months that have already been portioned out.
 * Call when a highlight is added (unless last day of month). On delete, DB CASCADE
 * removes the highlight from daily_summary_highlights; no redistribution needed.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    
    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const dayOfMonth = now.getDate()
    const daysInMonth = new Date(year, month, 0).getDate()

    // Don't redistribute if it's the last day of the month
    if (dayOfMonth === daysInMonth) {
      return NextResponse.json({
        message: 'Last day of month - skipping redistribution',
        skipped: true,
      })
    }

    // Use remaining days in current month (from tomorrow to end of month, excluding today)
    const remainingDaysInMonth = daysInMonth - dayOfMonth // Days from tomorrow to end of month (exclusive of today)
    const startDay = dayOfMonth + 1 // Start from tomorrow (exclude today)
    
    // If there are no remaining days (shouldn't happen due to check above, but safety check)
    if (remainingDaysInMonth <= 0) {
      return NextResponse.json({
        message: 'No remaining days in month - skipping redistribution',
        skipped: true,
      })
    }

    // Determine which future months to include: any month that has already been portioned out
    // (i.e. has at least one daily summary for this user). Check next month and beyond.
    const futureMonthsToAssign: Array<{ year: number; month: number }> = []
    for (let offset = 1; offset <= 6; offset++) {
      let ym = month + offset
      let yy = year
      while (ym > 12) {
        ym -= 12
        yy += 1
      }
      const start = `${yy}-${String(ym).padStart(2, '0')}-01`
      const end = `${yy}-${String(ym).padStart(2, '0')}-${String(new Date(yy, ym, 0).getDate()).padStart(2, '0')}`
      const { data: summaries } = await supabase
        .from('daily_summaries')
        .select('id')
        .eq('user_id', user.id)
        .gte('date', start)
        .lte('date', end)
      if (summaries && summaries.length > 0) {
        futureMonthsToAssign.push({ year: yy, month: ym })
      } else {
        break
      }
    }

    const monthYear = `${year}-${String(month).padStart(2, '0')}`

    // Fetch ALL unarchived highlights (Supabase default limit is 1000; paginate to get all)
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

    // Get highlights that have already been reviewed for this month (paginate to avoid 1000 limit)
    const reviewedHighlightIds = new Set<string>()
    let revFrom = 0
    while (true) {
      const { data: reviewedPage, error: reviewedError } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', monthYear)
        .range(revFrom, revFrom + PAGE - 1)
      if (reviewedError) throw reviewedError
      const page = (reviewedPage || []) as Array<{ highlight_id: string }>
      for (const r of page) reviewedHighlightIds.add(r.highlight_id)
      if (page.length < PAGE) break
      revFrom += PAGE
    }

    // Get existing assignments first to identify reviewed highlights (those with ratings)
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`

    const { data: existingSummariesForFilter, error: existingErrorForFilter } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('date', startDate)
      .lte('date', endDate)

    const reviewedHighlightIdsFromRatings = new Set<string>()
    if (existingSummariesForFilter && existingSummariesForFilter.length > 0) {
      const typedSummariesForFilter = existingSummariesForFilter as Array<{ id: string }>
      const summaryIdsForFilter = typedSummariesForFilter.map((s) => s.id)
      const { data: assignmentsWithRatings } = await supabase
        .from('daily_summary_highlights')
        .select('highlight_id')
        .in('daily_summary_id', summaryIdsForFilter)
        .not('rating', 'is', null)
      
      if (assignmentsWithRatings) {
        for (const assignment of assignmentsWithRatings as Array<{ highlight_id: string }>) {
          reviewedHighlightIdsFromRatings.add(assignment.highlight_id)
        }
      }
    }

    // Filter out highlights that have already been reviewed this month
    // (either in highlight_months_reviewed or have a rating in daily_summary_highlights)
    const allHighlights = ((allHighlightsData || []) as Array<{
      id: string
      text: string
      html_content: string | null
    }>).filter((h) => !reviewedHighlightIds.has(h.id) && !reviewedHighlightIdsFromRatings.has(h.id))

    if (allHighlights.length === 0) {
      return NextResponse.json({
        message: 'No highlights to redistribute',
      })
    }

    // Calculate score (character count) for each highlight
    const highlightsWithScore = allHighlights.map((h) => {
      const content = h.html_content || h.text || ''
      const plainText = content.replace(/<[^>]*>/g, '')
      const score = plainText.length

      return {
        id: h.id,
        text: h.text,
        html_content: h.html_content,
        score,
      }
    })

    const seededShuffle = <T,>(array: T[], seed: number): T[] => {
      const shuffled = [...array]
      let random = seed
      const seededRandom = () => {
        random = (random * 9301 + 49297) % 233280
        return random / 233280
      }
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(seededRandom() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      return shuffled
    }

    const hashStr = (s: string): number => {
      let h = 0
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
      return h
    }

    // Get existing assignments and preserve those for reviewed highlights
    const { data: existingSummaries, error: existingError } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('user_id', user.id)
      .gte('date', startDate)
      .lte('date', endDate)

    if (existingError) throw existingError

    // Get all existing assignments with their ratings to identify reviewed highlights
    const preservedAssignments = new Map<string, { date: string; summaryId: string }>() // highlight_id -> { date, summaryId }
    const completedDays = new Set<string>() // Set of dates (YYYY-MM-DD) that are completed
    const assignedThisMonthIds = new Set<string>() // highlight_ids already on some day this month (so we only place "new" ones)
    let allAssignmentsThisMonth: Array<{ highlight_id: string; daily_summary_id: string }> = []

    // Type the summaries outside the if block so it's accessible later
    const typedSummaries = (existingSummaries || []) as Array<{
      id: string
      date: string
    }>
    
    if (existingSummaries && existingSummaries.length > 0) {
      const summaryIds = typedSummaries.map((s) => s.id)
      
      // Get all assignments with ratings (reviewed highlights)
      const { data: existingAssignments, error: assignmentsError } = await supabase
        .from('daily_summary_highlights')
        .select('id, highlight_id, daily_summary_id, rating')
        .in('daily_summary_id', summaryIds)

      if (assignmentsError) throw assignmentsError

      // Track which days are completed (all highlights have ratings)
      // We'll preserve assignments for today and all completed days.
      // We only place highlights that are not yet assigned this month ("new").
      
      if (existingAssignments) {
        const typedAssignments = existingAssignments as Array<{
          id: string
          highlight_id: string
          daily_summary_id: string
          rating: number | null
        }>
        for (const a of typedAssignments) assignedThisMonthIds.add(a.highlight_id)
        allAssignmentsThisMonth = typedAssignments.map((a) => ({ highlight_id: a.highlight_id, daily_summary_id: a.daily_summary_id }))
        
        // Group assignments by date to check completion status
        const assignmentsByDate = new Map<string, Array<{
          highlight_id: string
          rating: number | null
        }>>()
        
        const todayDate = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`
        
        // First, group all assignments by date
        for (const assignment of typedAssignments) {
          const summary = typedSummaries.find((s) => s.id === assignment.daily_summary_id)
          if (summary) {
            if (!assignmentsByDate.has(summary.date)) {
              assignmentsByDate.set(summary.date, [])
            }
            assignmentsByDate.get(summary.date)!.push({
              highlight_id: assignment.highlight_id,
              rating: assignment.rating,
            })
          }
        }
        
        // Check which days are completed (all highlights have ratings)
        // This includes today if it's completed, and any future days that are completed
        for (const [date, dateAssignments] of assignmentsByDate.entries()) {
          const totalHighlights = dateAssignments.length
          const ratedHighlights = dateAssignments.filter((a) => a.rating !== null).length
          
          if (totalHighlights > 0 && ratedHighlights === totalHighlights) {
            // This day is completed - preserve its assignments (includes today if completed, and future days)
            completedDays.add(date)
            const summary = typedSummaries.find((s) => s.date === date)
            if (summary) {
              for (const assignment of dateAssignments) {
                preservedAssignments.set(assignment.highlight_id, {
                  date: summary.date,
                  summaryId: summary.id,
                })
              }
            }
          }
        }
        
        // Also preserve today's assignments even if today is not completed
        if (assignmentsByDate.has(todayDate)) {
          const todayAssignments = assignmentsByDate.get(todayDate)!
          const todaySummary = typedSummaries.find((s) => s.date === todayDate)
          if (todaySummary) {
            for (const assignment of todayAssignments) {
              // Only add if not already preserved (in case today is completed)
              if (!preservedAssignments.has(assignment.highlight_id)) {
                preservedAssignments.set(assignment.highlight_id, {
                  date: todaySummary.date,
                  summaryId: todaySummary.id,
                })
              }
            }
          }
        }
      }
    }

    // Only place highlights that are not yet assigned to any day this month ("new").
    // Existing assignments are left as-is.
    const highlightsToRedistribute = highlightsWithScore.filter(
      (h) => !assignedThisMonthIds.has(h.id)
    )

    // Add only "new" highlights to remaining days; leave all existing assignments as-is.
    const createdAssignments: any[] = []
    const idToScore = new Map(highlightsWithScore.map((h) => [h.id, h.score]))

    if (highlightsToRedistribute.length > 0) {
      const lastDayDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`
      const allRemainingDateStrs: string[] = []
      for (let d = startDay; d <= daysInMonth; d++) {
        allRemainingDateStrs.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
      }
      const allRemainingCompleted = allRemainingDateStrs.length > 0 && allRemainingDateStrs.every((d) => completedDays.has(d))

      if (allRemainingCompleted) {
        // All remaining days are fully done: add new highlight(s) to the last day only.
        const lastSummary = typedSummaries?.find((s) => s.date === lastDayDate)
        if (lastSummary) {
          const summaryHighlights = highlightsToRedistribute.map((h) => ({
            daily_summary_id: lastSummary.id,
            highlight_id: h.id,
          }))
          const { error: linkError } = await (supabase
            .from('daily_summary_highlights') as any)
            .insert(summaryHighlights)
          if (linkError) throw linkError
          createdAssignments.push({
            day: daysInMonth,
            date: lastDayDate,
            highlightCount: highlightsToRedistribute.length,
            totalScore: highlightsToRedistribute.reduce((sum, h) => sum + h.score, 0),
          })
        }
      } else {
        // Build remaining days with current totalScore (from existing assignments).
        const dayState: Array<{ date: string; day: number; summaryId: string | null; totalScore: number }> = []
        for (let d = startDay; d <= daysInMonth; d++) {
          const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          if (completedDays.has(date)) continue
          const summary = typedSummaries.find((s) => s.date === date)
          let totalScore = 0
          for (const a of allAssignmentsThisMonth) {
            if (summary && a.daily_summary_id === summary.id) {
              totalScore += idToScore.get(a.highlight_id) ?? 0
            }
          }
          dayState.push({
            date,
            day: d,
            summaryId: summary?.id ?? null,
            totalScore,
          })
        }

        const seed = year * 373 + month * 31
        const shuffledNew = seededShuffle(highlightsToRedistribute, seed)
        const sortedNew = [...shuffledNew].sort((a, b) => b.score - a.score)

        for (const highlight of sortedNew) {
          if (dayState.length === 0) break
          let minIdx = 0
          let minScore = dayState[0].totalScore
          for (let i = 1; i < dayState.length; i++) {
            if (dayState[i].totalScore < minScore) {
              minScore = dayState[i].totalScore
              minIdx = i
            }
          }
          const tiedIndices = dayState.map((_, i) => i).filter((i) => dayState[i].totalScore === minScore)
          if (tiedIndices.length > 1) {
            const tieSeed = (seed + hashStr(highlight.id)) >>> 0
            let r = tieSeed
            const rand = () => { r = (r * 9301 + 49297) % 233280; return r / 233280 }
            minIdx = tiedIndices[Math.floor(rand() * tiedIndices.length)]
          }
          const slot = dayState[minIdx]
          let summaryId = slot.summaryId
          if (!summaryId) {
            const { data: summaryData, error: summaryError } = await (supabase
              .from('daily_summaries') as any)
              .insert([{ date: slot.date, user_id: user.id }])
              .select()
              .single()
            if (summaryError) throw summaryError
            summaryId = summaryData.id
            slot.summaryId = summaryId
          }
          const { error: linkError } = await (supabase
            .from('daily_summary_highlights') as any)
            .insert([{ daily_summary_id: summaryId, highlight_id: highlight.id }])
          if (linkError) throw linkError
          slot.totalScore += highlight.score
          createdAssignments.push({
            day: slot.day,
            date: slot.date,
            highlightCount: 1,
            totalScore: highlight.score,
          })
        }
      }
    }

    // NOTE: Redistribute assigns only NEW highlights (not yet on any day this month) to
    // remaining days. Existing assignments are never removed or moved.

    // NOTE: We do NOT mark highlights as reviewed here.
    // Highlights should only be marked as reviewed when they receive a rating
    // in the daily review page (handleRatingChange in app/daily/page.tsx)

    // Assign to future months that have already been portioned out (have daily summaries)
    let futureMonthAssignments: any[] = []
    for (const fm of futureMonthsToAssign) {
      if (highlightsToRedistribute.length === 0) break

      const fmDaysInMonth = new Date(fm.year, fm.month, 0).getDate()
      const fmYearStr = `${fm.year}-${String(fm.month).padStart(2, '0')}`

      const { data: fmReviewedData } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', fmYearStr)
      const fmReviewedIds = new Set(
        (fmReviewedData || []).map((r: any) => r.highlight_id)
      )

      const fmStart = `${fm.year}-${String(fm.month).padStart(2, '0')}-01`
      const fmEnd = `${fm.year}-${String(fm.month).padStart(2, '0')}-${String(fmDaysInMonth).padStart(2, '0')}`
      const { data: fmSummaries } = await supabase
        .from('daily_summaries')
        .select('id')
        .eq('user_id', user.id)
        .gte('date', fmStart)
        .lte('date', fmEnd)

      const fmReviewedFromRatings = new Set<string>()
      if (fmSummaries && fmSummaries.length > 0) {
        const fmSummaryIds = (fmSummaries as Array<{ id: string }>).map((s) => s.id)
        const { data: fmRated } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id')
          .in('daily_summary_id', fmSummaryIds)
          .not('rating', 'is', null)
        if (fmRated) {
          for (const a of fmRated as Array<{ highlight_id: string }>) {
            fmReviewedFromRatings.add(a.highlight_id)
          }
        }
      }

      const highlightsForFm = highlightsToRedistribute.filter(
        (h) => !fmReviewedIds.has(h.id) && !fmReviewedFromRatings.has(h.id)
      )
      if (highlightsForFm.length === 0) continue

      const fmSeed = fm.year * 373 + fm.month * 31
      const fmShuffled = seededShuffle(highlightsForFm, fmSeed)
      const fmSorted = [...fmShuffled].sort((a, b) => b.score - a.score)
      const fmDays: Array<{
        day: number
        highlights: typeof highlightsForFm
        totalScore: number
      }> = Array.from({ length: fmDaysInMonth }, (_, i) => ({
        day: i + 1,
        highlights: [],
        totalScore: 0,
      }))

      for (const highlight of fmSorted) {
        let minScore = fmDays[0].totalScore
        for (let i = 1; i < fmDays.length; i++) {
          if (fmDays[i].totalScore < minScore) minScore = fmDays[i].totalScore
        }
        const tiedIndices = fmDays.map((_, i) => i).filter((i) => fmDays[i].totalScore === minScore)
        let minIdx = tiedIndices[0]
        if (tiedIndices.length > 1) {
          const tieSeed = (fmSeed + hashStr(highlight.id)) >>> 0
          let r = tieSeed
          const rand = () => { r = (r * 9301 + 49297) % 233280; return r / 233280 }
          minIdx = tiedIndices[Math.floor(rand() * tiedIndices.length)]
        }
        fmDays[minIdx].highlights.push(highlight)
        fmDays[minIdx].totalScore += highlight.score
      }

      // Shuffle highlights within each day so order is random, not longest-to-shortest
      for (const d of fmDays) {
        d.highlights = seededShuffle(d.highlights, (fmSeed + d.day) >>> 0)
      }

      const { data: existingFmSummaries } = await supabase
        .from('daily_summaries')
        .select('id, date')
        .eq('user_id', user.id)
        .gte('date', fmStart)
        .lte('date', fmEnd)
      const typedFmSummaries = (existingFmSummaries || []) as Array<{ id: string; date: string }>

      for (const assignment of fmDays) {
        if (assignment.highlights.length === 0) continue
        const date = `${fm.year}-${String(fm.month).padStart(2, '0')}-${String(assignment.day).padStart(2, '0')}`

        let summaryId: string | null = null
        const existingSummary = typedFmSummaries.find((s) => s.date === date)
        if (existingSummary) {
          summaryId = existingSummary.id
        } else {
          const { data: summaryData, error: summaryError } = await (supabase
            .from('daily_summaries') as any)
            .insert([{ date, user_id: user.id }])
            .select()
            .single()
          if (summaryError) throw summaryError
          summaryId = summaryData.id
        }
        if (!summaryId) continue

        const { data: existingAssignments } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id')
          .eq('daily_summary_id', summaryId)
          .in('highlight_id', assignment.highlights.map((h) => h.id))
        const existingIds = new Set(
          (existingAssignments || []).map((a: any) => a.highlight_id)
        )
        const newHighlights = assignment.highlights.filter((h) => !existingIds.has(h.id))
        if (newHighlights.length === 0) continue

        const { error: linkError } = await (supabase
          .from('daily_summary_highlights') as any)
          .insert(newHighlights.map((h) => ({
            daily_summary_id: summaryId,
            highlight_id: h.id,
          })))
        if (linkError) throw linkError

        futureMonthAssignments.push({
          day: assignment.day,
          date,
          highlightCount: newHighlights.length,
          totalScore: newHighlights.reduce((sum, h) => sum + h.score, 0),
        })
      }
    }

    const redistributedCount = highlightsToRedistribute.length > 0 ? highlightsToRedistribute.length : 0
    const futureMonthsLabel = futureMonthsToAssign.length > 0
      ? ` and ${futureMonthsToAssign.length} future month(s)`
      : ''
    return NextResponse.json({
      message: `Redistributed ${redistributedCount} highlights across remaining ${remainingDaysInMonth} days of current month (from day ${startDay}, excluding today)${futureMonthsLabel}`,
      assignments: createdAssignments || [],
      nextMonthAssignments: futureMonthAssignments,
      totalHighlights: redistributedCount,
      daysInMonth: remainingDaysInMonth,
      preservedCount: preservedAssignments.size,
      completedDaysCount: completedDays.size,
      assignedToFutureMonths: futureMonthsToAssign.length,
    })
  } catch (error: any) {
    console.error('Error redistributing highlights:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to redistribute highlights' },
      { status: 500 }
    )
  }
}

