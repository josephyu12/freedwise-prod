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
      const summaryIdsForFilter = existingSummariesForFilter.map((s: any) => s.id)
      const { data: assignmentsWithRatings } = await supabase
        .from('daily_summary_highlights')
        .select('highlight_id')
        .in('daily_summary_id', summaryIdsForFilter)
        .not('rating', 'is', null)
      
      if (assignmentsWithRatings) {
        for (const assignment of assignmentsWithRatings) {
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
    
    if (existingSummaries && existingSummaries.length > 0) {
      const summaryIds = existingSummaries.map((s: any) => s.id)
      
      // Get all assignments with ratings (reviewed highlights)
      const { data: existingAssignments, error: assignmentsError } = await supabase
        .from('daily_summary_highlights')
        .select('id, highlight_id, daily_summary_id, rating')
        .in('daily_summary_id', summaryIds)

      if (assignmentsError) throw assignmentsError

      // Preserve assignments for highlights that have been reviewed (have a rating)
      if (existingAssignments) {
        for (const assignment of existingAssignments) {
          if (assignment.rating !== null) {
            // This highlight has been reviewed, preserve its assignment
            const summary = existingSummaries.find((s: any) => s.id === assignment.daily_summary_id)
            if (summary) {
              preservedAssignments.set(assignment.highlight_id, {
                date: summary.date,
                summaryId: summary.id,
              })
            }
          }
        }
      }

      // Remove assignments for non-reviewed highlights only
      // We'll delete all daily_summary_highlights that don't have ratings
      const nonReviewedAssignmentIds = (existingAssignments || [])
        .filter((a: any) => a.rating === null)
        .map((a: any) => a.id)

      if (nonReviewedAssignmentIds.length > 0) {
        await supabase
          .from('daily_summary_highlights')
          .delete()
          .in('id', nonReviewedAssignmentIds)
      }

      // Delete daily_summaries that no longer have any assignments
      // But first, check which summaries still have assignments
      const { data: remainingAssignments } = await supabase
        .from('daily_summary_highlights')
        .select('daily_summary_id')
        .in('daily_summary_id', summaryIds)

      const summariesWithAssignments = new Set(
        (remainingAssignments || []).map((a: any) => a.daily_summary_id)
      )

      const summariesToDelete = existingSummaries
        .filter((s: any) => !summariesWithAssignments.has(s.id))
        .map((s: any) => s.id)

      if (summariesToDelete.length > 0) {
        await supabase
          .from('daily_summaries')
          .delete()
          .in('id', summariesToDelete)
      }
    }

    // Filter out reviewed highlights from redistribution
    const highlightsToRedistribute = highlightsWithScore.filter(
      (h) => !preservedAssignments.has(h.id)
    )

    // Create or update daily summaries and assignments for non-reviewed highlights
    const createdAssignments: any[] = []

    // Only redistribute if there are highlights to redistribute
    if (highlightsToRedistribute.length > 0) {
      // Recalculate assignments only for non-reviewed highlights
      const seed = year * 100 + month
      const shuffledHighlights = seededShuffle(highlightsToRedistribute, seed)
      const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)
      const totalScore = highlightsToRedistribute.reduce((sum, h) => sum + h.score, 0)
      const targetScorePerDay = totalScore / daysInMonth

      // Initialize days, but account for preserved assignments
      const days: Array<{
        day: number
        highlights: typeof highlightsToRedistribute
        totalScore: number
      }> = Array.from({ length: daysInMonth }, (_, i) => {
        const day = i + 1
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        
        // Check if there are preserved assignments for this day
        let preservedScore = 0
        for (const [highlightId, assignment] of preservedAssignments.entries()) {
          if (assignment.date === date) {
            const highlight = highlightsWithScore.find((h) => h.id === highlightId)
            if (highlight) {
              preservedScore += highlight.score
            }
          }
        }

        return {
          day,
          highlights: [],
          totalScore: preservedScore, // Start with preserved assignments' score
        }
      })

      // Assign non-reviewed highlights
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

        // Check if summary already exists (might have preserved assignments)
        let summaryId: string | null = null
        const existingSummary = existingSummaries?.find((s: any) => s.date === date)
        
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
        if (summaryId && assignment.highlights.length > 0) {
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
    }

    // NOTE: We do NOT mark highlights as reviewed here.
    // Highlights should only be marked as reviewed when they receive a rating
    // in the daily review page (handleRatingChange in app/daily/page.tsx)

    const redistributedCount = highlightsToRedistribute.length > 0 ? highlightsToRedistribute.length : 0
    return NextResponse.json({
      message: `Redistributed ${redistributedCount} highlights across ${daysInMonth} days`,
      assignments: createdAssignments || [],
      totalHighlights: redistributedCount,
      daysInMonth,
      preservedCount: preservedAssignments.size,
    })
  } catch (error: any) {
    console.error('Error redistributing highlights:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to redistribute highlights' },
      { status: 500 }
    )
  }
}

