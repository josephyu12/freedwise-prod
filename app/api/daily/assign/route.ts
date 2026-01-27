import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface HighlightWithScore {
  id: string
  text: string
  html_content: string | null
  score: number // Character count
}

interface DayAssignment {
  day: number // 1-31
  highlights: HighlightWithScore[]
  totalScore: number
}

/**
 * Seeded shuffle function for deterministic randomization
 * Uses a seed to ensure same seed produces same shuffle
 */
function seededShuffle<T>(array: T[], seed: number): T[] {
  const shuffled = [...array]
  let random = seed
  
  // Simple seeded random number generator
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

/**
 * Assigns highlights to days of the month using a bin-packing algorithm
 * to ensure roughly equal total character counts per day
 * Uses a seeded shuffle based on month/year to provide variety month-to-month
 */
function assignHighlightsToDays(
  highlights: HighlightWithScore[],
  daysInMonth: number,
  year: number,
  month: number
): DayAssignment[] {
  // Create a seed from year and month for deterministic but varied shuffling
  // This ensures each month gets a different order, but the same month always gets the same order
  const seed = year * 100 + month
  
  // Shuffle highlights with seed to add variety month-to-month
  // Then sort by score for better bin-packing
  const shuffledHighlights = seededShuffle(highlights, seed)
  const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)
  
  // Initialize days with empty arrays
  const days: DayAssignment[] = Array.from({ length: daysInMonth }, (_, i) => ({
    day: i + 1,
    highlights: [],
    totalScore: 0,
  }))

  // Calculate target score per day
  const totalScore = highlights.reduce((sum, h) => sum + h.score, 0)
  const targetScorePerDay = totalScore / daysInMonth

  // Assign each highlight to the day with the lowest current total score
  for (const highlight of sortedHighlights) {
    // Find the day with the lowest total score
    let minDayIndex = 0
    let minScore = days[0].totalScore

    for (let i = 1; i < days.length; i++) {
      if (days[i].totalScore < minScore) {
        minScore = days[i].totalScore
        minDayIndex = i
      }
    }

    // Assign highlight to this day
    days[minDayIndex].highlights.push(highlight)
    days[minDayIndex].totalScore += highlight.score
  }

  return days
}

/**
 * POST /api/daily/assign
 * Assigns highlights to days for a given month
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

    const body = await request.json()
    const { year, month } = body

    if (!year || !month) {
      return NextResponse.json(
        { error: 'Year and month are required' },
        { status: 400 }
      )
    }

    // Validate month (1-12)
    if (month < 1 || month > 12) {
      return NextResponse.json(
        { error: 'Month must be between 1 and 12' },
        { status: 400 }
      )
    }

    const daysInMonth = new Date(year, month, 0).getDate()
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

    // Filter out highlights that have already been reviewed this month
    const allHighlights = ((allHighlightsData || []) as Array<{
      id: string
      text: string
      html_content: string | null
    }>).filter((h) => !reviewedHighlightIds.has(h.id))

    if (allHighlights.length === 0) {
      return NextResponse.json({
        message: 'No highlights to assign',
        assignments: [],
      })
    }

    // Calculate score (character count) for each highlight
    const highlightsWithScore: HighlightWithScore[] = allHighlights.map((h) => {
      // Use html_content if available, otherwise use text
      const content = h.html_content || h.text || ''
      // Strip HTML tags to get actual character count
      const plainText = content.replace(/<[^>]*>/g, '')
      const score = plainText.length

      return {
        id: h.id,
        text: h.text,
        html_content: h.html_content,
        score,
      }
    })

    // Assign highlights to days (pass year and month for seeded shuffle)
    const assignments = assignHighlightsToDays(highlightsWithScore, daysInMonth, year, month)

    // Get existing assignments and preserve those for completed days
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`

    const { data: existingSummaries, error: existingError } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('user_id', user.id)
      .gte('date', startDate)
      .lte('date', endDate)

    if (existingError) throw existingError

    // Track which days are completed (all highlights have ratings)
    const completedDays = new Set<string>() // Set of dates (YYYY-MM-DD) that are completed
    const preservedAssignments = new Map<string, { date: string; summaryId: string }>() // highlight_id -> { date, summaryId }
    
    const typedSummaries = (existingSummaries || []) as Array<{
      id: string
      date: string
    }>
    
    if (existingSummaries && existingSummaries.length > 0) {
      const summaryIds = typedSummaries.map((s) => s.id)
      
      // Get all existing assignments with their ratings
      const { data: existingAssignments, error: assignmentsError } = await supabase
        .from('daily_summary_highlights')
        .select('id, highlight_id, daily_summary_id, rating')
        .in('daily_summary_id', summaryIds)

      if (assignmentsError) throw assignmentsError

      // Group assignments by summary/date to check completion status
      const assignmentsByDate = new Map<string, Array<{
        highlight_id: string
        rating: number | null
      }>>()

      if (existingAssignments) {
        const typedAssignments = existingAssignments as Array<{
          id: string
          highlight_id: string
          daily_summary_id: string
          rating: number | null
        }>
        
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
      }

      // Check which days are completed (all highlights have ratings)
      for (const [date, dateAssignments] of assignmentsByDate.entries()) {
        const totalHighlights = dateAssignments.length
        const ratedHighlights = dateAssignments.filter((a) => a.rating !== null).length
        
        if (totalHighlights > 0 && ratedHighlights === totalHighlights) {
          // This day is completed - preserve all its assignments
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

      // Delete assignments only for non-completed days
      const summariesToModify = typedSummaries.filter((s) => !completedDays.has(s.date))
      const summaryIdsToModify = summariesToModify.map((s) => s.id)
      
      if (summaryIdsToModify.length > 0) {
        // Delete daily_summary_highlights for non-completed days
        await supabase
          .from('daily_summary_highlights')
          .delete()
          .in('daily_summary_id', summaryIdsToModify)

        // Delete daily_summaries for non-completed days that no longer have assignments
        // (We'll recreate them below if needed)
        await supabase
          .from('daily_summaries')
          .delete()
          .in('id', summaryIdsToModify)
      }
    }

    // Filter out highlights that are already preserved in completed days
    const highlightsToAssign = highlightsWithScore.filter(
      (h) => !preservedAssignments.has(h.id)
    )

    // Recalculate assignments only for non-preserved highlights
    const newAssignments = highlightsToAssign.length > 0
      ? assignHighlightsToDays(highlightsToAssign, daysInMonth, year, month)
      : []

    // Create daily summaries and assignments
    const createdAssignments: any[] = []

    for (const assignment of newAssignments) {
      if (assignment.highlights.length === 0) continue

      const date = `${year}-${String(month).padStart(2, '0')}-${String(assignment.day).padStart(2, '0')}`

      // Skip if this day is already completed
      if (completedDays.has(date)) continue

      // Check if summary already exists (shouldn't happen after deletion, but be safe)
      let summaryId: string | null = null
      const existingSummary = typedSummaries.find((s) => s.date === date)
      
      if (existingSummary && !completedDays.has(date)) {
        // Summary exists but day is not completed - should have been deleted, but handle it
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

      // Link highlights to summary
      if (summaryId) {
        const summaryHighlights = assignment.highlights.map((h) => ({
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
          highlightCount: assignment.highlights.length,
          totalScore: assignment.totalScore,
        })
      }
    }

    // Verify that every highlight is assigned to at least one day
    // Get all highlights that should be assigned (non-reviewed, non-archived)
    const allHighlightIds = new Set(highlightsWithScore.map((h) => h.id))
    const assignedHighlightIds = new Set<string>()
    
    // Add preserved assignments
    for (const highlightId of preservedAssignments.keys()) {
      if (allHighlightIds.has(highlightId)) {
        assignedHighlightIds.add(highlightId)
      }
    }
    
    // Add newly created assignments
    for (const assignment of newAssignments) {
      for (const highlight of assignment.highlights) {
        assignedHighlightIds.add(highlight.id)
      }
    }
    
    // Check for unassigned highlights
    const unassignedHighlights = highlightsWithScore.filter(
      (h) => !assignedHighlightIds.has(h.id)
    )
    
    // If there are unassigned highlights, assign them to non-completed days
    if (unassignedHighlights.length > 0) {
      // Get all non-completed days
      const availableDays: number[] = []
      for (let day = 1; day <= daysInMonth; day++) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        if (!completedDays.has(date)) {
          availableDays.push(day)
        }
      }
      
      if (availableDays.length > 0) {
        // Assign unassigned highlights to available days using bin-packing
        const unassignedWithScore = unassignedHighlights.map((h) => ({
          id: h.id,
          text: h.text,
          html_content: h.html_content,
          score: h.score,
        }))
        
        const unassignedAssignments = assignHighlightsToDays(
          unassignedWithScore,
          availableDays.length,
          year,
          month
        )
        
        // Map the assignments to actual day numbers
        for (let i = 0; i < unassignedAssignments.length; i++) {
          const assignment = unassignedAssignments[i]
          const actualDay = availableDays[i]
          const date = `${year}-${String(month).padStart(2, '0')}-${String(actualDay).padStart(2, '0')}`
          
          if (assignment.highlights.length > 0) {
            // Get or create summary for this day
            let summaryId: string | null = null
            const existingSummary = typedSummaries.find((s) => s.date === date)
            
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
            
            if (summaryId) {
              const summaryHighlights = assignment.highlights.map((h) => ({
                daily_summary_id: summaryId,
                highlight_id: h.id,
              }))
              
              const { error: linkError } = await (supabase
                .from('daily_summary_highlights') as any)
                .insert(summaryHighlights)
              
              if (linkError) throw linkError
              
              createdAssignments.push({
                day: actualDay,
                date,
                highlightCount: assignment.highlights.length,
                totalScore: assignment.totalScore,
              })
            }
          }
        }
      }
    }

    // NOTE: We do NOT mark highlights as reviewed here.
    // Highlights should only be marked as reviewed when they receive a rating
    // in the daily review page (handleRatingChange in app/daily/page.tsx)

    const preservedCount = preservedAssignments.size
    const completedDaysCount = completedDays.size
    const totalAssigned = assignedHighlightIds.size + unassignedHighlights.length

    return NextResponse.json({
      message: `Assigned ${highlightsToAssign.length} highlights across ${daysInMonth} days${completedDaysCount > 0 ? ` (preserved ${completedDaysCount} completed days)` : ''}${unassignedHighlights.length > 0 ? ` (assigned ${unassignedHighlights.length} previously unassigned highlights)` : ''}`,
      assignments: createdAssignments,
      totalHighlights: highlightsToAssign.length,
      daysInMonth,
      preservedCount,
      completedDaysCount,
      unassignedCount: unassignedHighlights.length,
      totalAssigned,
    })
  } catch (error: any) {
    console.error('Error assigning highlights to days:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to assign highlights' },
      { status: 500 }
    )
  }
}

