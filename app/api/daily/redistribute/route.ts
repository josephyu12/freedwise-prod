import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/daily/redistribute
 * Redistributes highlights for the current month when new highlights are added
 * This should be called when a highlight is added (unless it's the last day of the month)
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

    // Check if we should also assign to next month (if on or after 24th)
    const shouldAssignToNextMonth = dayOfMonth >= 24
    let nextMonthYear = year
    let nextMonth = month + 1
    if (nextMonth > 12) {
      nextMonth = 1
      nextMonthYear = year + 1
    }

    const monthYear = `${year}-${String(month).padStart(2, '0')}`

    // Get all unarchived highlights for this user
    const { data: allHighlightsData, error: highlightsError } = await supabase
      .from('highlights')
      .select('id, text, html_content')
      .eq('user_id', user.id)
      .eq('archived', false)

    if (highlightsError) throw highlightsError

    // Get highlights that have already been reviewed for this month
    const { data: reviewedHighlightsData, error: reviewedError } = await supabase
      .from('highlight_months_reviewed')
      .select('highlight_id')
      .eq('month_year', monthYear)

    if (reviewedError) throw reviewedError

    const reviewedHighlightIds = new Set(
      (reviewedHighlightsData || []).map((r: any) => r.highlight_id)
    )

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

    // Seeded shuffle function for deterministic randomization
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

    // Create a seed from year and month for deterministic but varied shuffling
    const seed = year * 100 + month
    
    // Shuffle highlights with seed to add variety month-to-month
    // Then sort by score for better bin-packing
    const shuffledHighlights = seededShuffle(highlightsWithScore, seed)
    const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)
    const totalScore = highlightsWithScore.reduce((sum, h) => sum + h.score, 0)
    const targetScorePerDay = totalScore / daysInMonth

    const days: Array<{
      day: number
      highlights: typeof highlightsWithScore
      totalScore: number
    }> = Array.from({ length: daysInMonth }, (_, i) => ({
      day: i + 1,
      highlights: [],
      totalScore: 0,
    }))

    for (const highlight of sortedHighlights) {
      let minDayIndex = 0
      let minScore = days[0].totalScore

      for (let i = 1; i < days.length; i++) {
        if (days[i].totalScore < minScore) {
          minScore = days[i].totalScore
          minDayIndex = i
        }
      }

      days[minDayIndex].highlights.push(highlight)
      days[minDayIndex].totalScore += highlight.score
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
      // Recalculate assignments only for non-reviewed highlights
      const seed = year * 100 + month
      const shuffledHighlights = seededShuffle(highlightsToRedistribute, seed)
      const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)
      const totalScore = highlightsToRedistribute.reduce((sum, h) => sum + h.score, 0)
      
      // Always assign to remaining days in current month (from today onwards)
      const targetScorePerDay = totalScore / remainingDaysInMonth

      // Initialize days for remaining days (from tomorrow to end of month, excluding completed days)
      for (let i = 0; i < remainingDaysInMonth; i++) {
        const day = startDay + i
        if (day > daysInMonth) break // Safety check
        
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        
        // Skip completed days entirely
        if (completedDays.has(date)) {
          continue
        }

        days.push({
          day,
          highlights: [],
          totalScore: 0, // Start fresh - we've already deleted assignments from these days
        })
      }

      // Assign non-reviewed highlights to current month (remaining days)
      for (const highlight of sortedHighlights) {
        let minDayIndex = 0
        let minScore = days[0].totalScore

        for (let i = 1; i < days.length; i++) {
          if (days[i].totalScore < minScore) {
            minScore = days[i].totalScore
            minDayIndex = i
          }
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

    // If after 24th, also assign to next month
    let nextMonthAssignments: any[] = []
    if (shouldAssignToNextMonth && highlightsToRedistribute.length > 0) {
      const nextMonthDaysInMonth = new Date(nextMonthYear, nextMonth, 0).getDate()
      const nextMonthYearStr = `${nextMonthYear}-${String(nextMonth).padStart(2, '0')}`
      
      // Get highlights that have already been reviewed for next month
      const { data: nextMonthReviewedData } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', nextMonthYearStr)

      const nextMonthReviewedIds = new Set(
        (nextMonthReviewedData || []).map((r: any) => r.highlight_id)
      )
      
      // Get existing assignments for next month to identify reviewed highlights
      const nextMonthStartDate = `${nextMonthYear}-${String(nextMonth).padStart(2, '0')}-01`
      const nextMonthEndDate = `${nextMonthYear}-${String(nextMonth).padStart(2, '0')}-${String(nextMonthDaysInMonth).padStart(2, '0')}`
      
      const { data: nextMonthSummaries } = await supabase
        .from('daily_summaries')
        .select('id')
        .eq('user_id', user.id)
        .gte('date', nextMonthStartDate)
        .lte('date', nextMonthEndDate)

      const nextMonthReviewedIdsFromRatings = new Set<string>()
      if (nextMonthSummaries && nextMonthSummaries.length > 0) {
        const nextMonthSummaryIds = (nextMonthSummaries as Array<{ id: string }>).map((s) => s.id)
        const { data: nextMonthAssignmentsWithRatings } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id')
          .in('daily_summary_id', nextMonthSummaryIds)
          .not('rating', 'is', null)
        
        if (nextMonthAssignmentsWithRatings) {
          for (const assignment of nextMonthAssignmentsWithRatings as Array<{ highlight_id: string }>) {
            nextMonthReviewedIdsFromRatings.add(assignment.highlight_id)
          }
        }
      }

      // Filter out highlights already reviewed for next month
      const highlightsForNextMonth = highlightsToRedistribute.filter(
        (h) => !nextMonthReviewedIds.has(h.id) && !nextMonthReviewedIdsFromRatings.has(h.id)
      )

      if (highlightsForNextMonth.length > 0) {
        // Calculate assignments for next month
        const nextMonthSeed = nextMonthYear * 100 + nextMonth
        const nextMonthShuffled = seededShuffle(highlightsForNextMonth, nextMonthSeed)
        const nextMonthSorted = [...nextMonthShuffled].sort((a, b) => b.score - a.score)
        const nextMonthTotalScore = highlightsForNextMonth.reduce((sum, h) => sum + h.score, 0)
        const nextMonthTargetScorePerDay = nextMonthTotalScore / nextMonthDaysInMonth

        const nextMonthDays: Array<{
          day: number
          highlights: typeof highlightsForNextMonth
          totalScore: number
        }> = Array.from({ length: nextMonthDaysInMonth }, (_, i) => ({
          day: i + 1,
          highlights: [],
          totalScore: 0,
        }))

        // Assign highlights to next month
        for (const highlight of nextMonthSorted) {
          let minDayIndex = 0
          let minScore = nextMonthDays[0].totalScore

          for (let i = 1; i < nextMonthDays.length; i++) {
            if (nextMonthDays[i].totalScore < minScore) {
              minScore = nextMonthDays[i].totalScore
              minDayIndex = i
            }
          }

          nextMonthDays[minDayIndex].highlights.push(highlight)
          nextMonthDays[minDayIndex].totalScore += highlight.score
        }

        // Get existing summaries for next month
        const { data: existingNextMonthSummaries } = await supabase
          .from('daily_summaries')
          .select('id, date')
          .eq('user_id', user.id)
          .gte('date', nextMonthStartDate)
          .lte('date', nextMonthEndDate)

        const typedNextMonthSummaries = (existingNextMonthSummaries || []) as Array<{
          id: string
          date: string
        }>

        // Create or update assignments for next month
        for (const assignment of nextMonthDays) {
          if (assignment.highlights.length === 0) continue

          const date = `${nextMonthYear}-${String(nextMonth).padStart(2, '0')}-${String(assignment.day).padStart(2, '0')}`

          // Check if summary already exists
          let summaryId: string | null = null
          const existingSummary = typedNextMonthSummaries.find((s) => s.date === date)
          
          if (existingSummary) {
            summaryId = existingSummary.id
          } else {
            // Create new summary
            const { data: summaryData, error: summaryError } = await (supabase
              .from('daily_summaries') as any)
              .insert([{ date, user_id: user.id }])
              .select()
              .single()

            if (summaryError) throw summaryError
            summaryId = summaryData.id
          }

          // Only proceed if we have a valid summaryId
          if (!summaryId) {
            console.error(`[REDISTRIBUTE] Failed to get or create summary for date ${date}`)
            continue
          }

          // Check if highlights are already assigned to this summary
          const { data: existingAssignments } = await supabase
            .from('daily_summary_highlights')
            .select('highlight_id')
            .eq('daily_summary_id', summaryId)
            .in('highlight_id', assignment.highlights.map((h) => h.id))

          const existingHighlightIds = new Set(
            (existingAssignments || []).map((a: any) => a.highlight_id)
          )

          // Only add highlights that aren't already assigned
          const newHighlights = assignment.highlights.filter(
            (h) => !existingHighlightIds.has(h.id)
          )

          if (newHighlights.length > 0) {
            const summaryHighlights = newHighlights.map((h) => ({
              daily_summary_id: summaryId!,
              highlight_id: h.id,
            }))

            const { error: linkError } = await (supabase
              .from('daily_summary_highlights') as any)
              .insert(summaryHighlights)

            if (linkError) throw linkError

            nextMonthAssignments.push({
              day: assignment.day,
              date,
              highlightCount: newHighlights.length,
              totalScore: newHighlights.reduce((sum, h) => sum + h.score, 0),
            })
          }
        }
      }
    }

    const redistributedCount = highlightsToRedistribute.length > 0 ? highlightsToRedistribute.length : 0
    return NextResponse.json({
      message: shouldAssignToNextMonth
        ? `Redistributed ${redistributedCount} highlights across remaining ${remainingDaysInMonth} days of current month (from day ${startDay}, excluding today) and next month`
        : `Redistributed ${redistributedCount} highlights across remaining ${remainingDaysInMonth} days of current month (from day ${startDay}, excluding today)`,
      assignments: createdAssignments || [],
      nextMonthAssignments: nextMonthAssignments || [],
      totalHighlights: redistributedCount,
      daysInMonth: remainingDaysInMonth,
      preservedCount: preservedAssignments.size,
      completedDaysCount: completedDays.size,
      assignedToNextMonth: shouldAssignToNextMonth,
    })
  } catch (error: any) {
    console.error('Error redistributing highlights:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to redistribute highlights' },
      { status: 500 }
    )
  }
}

