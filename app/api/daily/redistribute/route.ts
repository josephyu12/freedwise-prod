import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/daily/redistribute
 * Redistributes highlights for the current month when new highlights are added.
 * Only affects future days: strictly after today (tomorrow through end of month).
 * Today is never changed. Future days that have already been reviewed (all highlights
 * rated) are also left unchanged. Also assigns to future months that have already been
 * portioned out (have at least one daily summary); assigns across all days of each
 * such month. Call when a highlight is added (unless last day of month).
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
      // We'll preserve assignments for:
      // 1. Today (regardless of completion status)
      // 2. All completed days (including future completed days)
      // All other assignments in remaining days will be removed and redistributed
      
      if (existingAssignments) {
        const typedAssignments = existingAssignments as Array<{
          id: string
          highlight_id: string
          daily_summary_id: string
          rating: number | null
        }>
        
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
        
        // Delete assignments from remaining days (tomorrow onwards) that are not completed
        // Get summaries for remaining days (excluding today and completed days)
        const remainingDaySummaries = typedSummaries.filter((s) => {
          const summaryDate = new Date(s.date)
          const summaryDay = summaryDate.getDate()
          // Exclude today and completed days from deletion
          return summaryDay >= startDay && summaryDay <= daysInMonth && !completedDays.has(s.date) && s.date !== todayDate
        })
        
        if (remainingDaySummaries.length > 0) {
          const remainingSummaryIds = remainingDaySummaries.map((s) => s.id)
          
          // Delete all assignments from remaining days (they'll be redistributed)
          await supabase
            .from('daily_summary_highlights')
            .delete()
            .in('daily_summary_id', remainingSummaryIds)
          
          // Delete summaries that no longer have assignments (they'll be recreated)
          await supabase
            .from('daily_summaries')
            .delete()
            .in('id', remainingSummaryIds)
        }
      }
    }

    // Redistribute ALL highlights (except reviewed ones and those preserved in completed days/today)
    // Filter out highlights that are preserved (in completed days or today)
    const highlightsToRedistribute = highlightsWithScore.filter(
      (h) => !preservedAssignments.has(h.id)
    )

    // Create or update daily summaries and assignments for non-reviewed highlights
    const createdAssignments: any[] = []
    
    // Initialize days array outside the if block so it's accessible for validation
    const days: Array<{
      day: number
      highlights: typeof highlightsToRedistribute
      totalScore: number
    }> = []

    // Only redistribute if there are highlights to redistribute
    if (highlightsToRedistribute.length > 0) {
      const seed = year * 373 + month * 31
      const shuffledHighlights = seededShuffle(highlightsToRedistribute, seed)
      const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)
      const totalScore = highlightsToRedistribute.reduce((sum, h) => sum + h.score, 0)
      const targetScorePerDay = totalScore / remainingDaysInMonth

      for (let i = 0; i < remainingDaysInMonth; i++) {
        const day = startDay + i
        if (day > daysInMonth) break
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        if (completedDays.has(date)) continue
        days.push({ day, highlights: [], totalScore: 0 })
      }

      for (const highlight of sortedHighlights) {
        let minScore = days[0].totalScore
        for (let i = 1; i < days.length; i++) {
          if (days[i].totalScore < minScore) minScore = days[i].totalScore
        }
        const tiedIndices = days.map((_, i) => i).filter((i) => days[i].totalScore === minScore)
        let minDayIndex = tiedIndices[0]
        if (tiedIndices.length > 1) {
          const tieSeed = (seed + hashStr(highlight.id)) >>> 0
          let r = tieSeed
          const rand = () => { r = (r * 9301 + 49297) % 233280; return r / 233280 }
          minDayIndex = tiedIndices[Math.floor(rand() * tiedIndices.length)]
        }
        days[minDayIndex].highlights.push(highlight)
        days[minDayIndex].totalScore += highlight.score
      }

      for (const assignment of days) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(assignment.day).padStart(2, '0')}`

        // Skip completed days (shouldn't be in days array, but double-check for safety)
        if (completedDays.has(date)) {
          continue
        }

        // Check if summary already exists (might have preserved assignments)
        let summaryId: string | null = null
        const existingSummary = typedSummaries?.find((s) => s.date === date)
        
        if (existingSummary) {
          summaryId = existingSummary.id
        } else if (assignment.highlights.length > 0) {
          // Create new summary only if there are highlights to assign
          const { data: summaryData, error: summaryError } = await (supabase
            .from('daily_summaries') as any)
            .insert([{ date, user_id: user.id }])
            .select()
            .single()

          if (summaryError) throw summaryError
          summaryId = summaryData.id
        }

        // Add assignments for non-reviewed highlights
        // Filter out highlights that are already assigned to this summary (safety check)
        if (summaryId && assignment.highlights.length > 0) {
          // Check which highlights are already assigned to this summary
          const { data: existingAssignmentsForSummary } = await supabase
            .from('daily_summary_highlights')
            .select('highlight_id')
            .eq('daily_summary_id', summaryId)
            .in('highlight_id', assignment.highlights.map((h) => h.id))

          const existingHighlightIds = new Set(
            (existingAssignmentsForSummary || []).map((a: any) => a.highlight_id)
          )

          // Only insert highlights that aren't already assigned
          const newHighlights = assignment.highlights.filter(
            (h) => !existingHighlightIds.has(h.id)
          )

          if (newHighlights.length > 0) {
            const summaryHighlights = newHighlights.map((h) => ({
              daily_summary_id: summaryId,
              highlight_id: h.id,
            }))

            const { error: linkError } = await (supabase
              .from('daily_summary_highlights') as any)
              .insert(summaryHighlights)

            if (linkError) throw linkError

            createdAssignments.push({
              day: assignment.day,
              date,
              highlightCount: newHighlights.length,
              totalScore: newHighlights.reduce((sum, h) => sum + h.score, 0),
            })
          }
        }
      }
    }

    // NOTE: Redistribute assigns ALL highlights (except reviewed/preserved) evenly across
    // remaining days (from tomorrow to end of month, excluding today and completed days)
    // Preserves: today's assignments (always) and all completed days (including future ones)
    // Full month coverage is ensured by the assign endpoint, which should be called
    // at the start of each month or when needed

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

