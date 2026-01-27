import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/daily/cleanup
 * Removes incorrectly assigned highlights from a completed day
 * Only removes highlights without ratings (the "extra" ones)
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
    const { date } = body // Format: "YYYY-MM-DD" e.g., "2026-01-26"

    if (!date) {
      return NextResponse.json(
        { error: 'Date is required (format: YYYY-MM-DD)' },
        { status: 400 }
      )
    }

    // Get the daily summary for this date
    const { data: summary, error: summaryError } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('date', date)
      .eq('user_id', user.id)
      .maybeSingle()

    if (summaryError) throw summaryError

    if (!summary) {
      return NextResponse.json({
        message: `No daily summary found for ${date}`,
        removedCount: 0,
      })
    }

    // Type assertion for summary
    const typedSummary = summary as { id: string; date: string }

    // Get all highlights assigned to this day
    const { data: allAssignments, error: assignmentsError } = await supabase
      .from('daily_summary_highlights')
      .select('id, highlight_id, rating')
      .eq('daily_summary_id', typedSummary.id)

    if (assignmentsError) throw assignmentsError

    if (!allAssignments || allAssignments.length === 0) {
      return NextResponse.json({
        message: `No highlights found for ${date}`,
        removedCount: 0,
      })
    }

    // Separate highlights with ratings (should keep) from those without (should remove)
    const highlightsWithRatings = allAssignments.filter((a: any) => a.rating !== null)
    const highlightsWithoutRatings = allAssignments.filter((a: any) => a.rating === null)

    // If the day is completed (all highlights have ratings), remove any unrated ones
    // If the day is not completed, we should be more careful
    const isCompleted = highlightsWithRatings.length > 0 && highlightsWithoutRatings.length === 0
      ? false // Actually, if there are no unrated, it might be completed
      : highlightsWithRatings.length === allAssignments.length // All have ratings = completed

    // For a completed day, remove all unrated highlights
    // For an incomplete day, we'll still remove unrated ones that were added after completion
    // (This is a cleanup operation, so we'll remove unrated highlights)
    const idsToRemove = highlightsWithoutRatings.map((a: any) => a.id)
    const highlightIdsToReassign = highlightsWithoutRatings.map((a: any) => a.highlight_id)

    if (idsToRemove.length === 0) {
      return NextResponse.json({
        message: `No unrated highlights to remove for ${date}. All ${allAssignments.length} highlights have ratings.`,
        removedCount: 0,
        totalHighlights: allAssignments.length,
        ratedHighlights: highlightsWithRatings.length,
      })
    }

    // Remove unrated highlights from this day
    const { error: deleteError } = await supabase
      .from('daily_summary_highlights')
      .delete()
      .in('id', idsToRemove)

    if (deleteError) throw deleteError

    // Reassign these highlights to remaining days in the month
    let reassignedCount = 0
    if (highlightIdsToReassign.length > 0) {
      // Parse the date to get year and month
      const dateObj = new Date(date)
      const year = dateObj.getFullYear()
      const month = dateObj.getMonth() + 1
      const dayOfMonth = dateObj.getDate()
      const daysInMonth = new Date(year, month, 0).getDate()
      
      // Get remaining days (from tomorrow to end of month, excluding today and completed days)
      const remainingDays: number[] = []
      const todayDate = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`
      
      // Get all summaries for this month to find completed days
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`
      const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`
      
      const { data: monthSummaries } = await supabase
        .from('daily_summaries')
        .select('id, date')
        .eq('user_id', user.id)
        .gte('date', startDate)
        .lte('date', endDate)
      
      const completedDays = new Set<string>()
      if (monthSummaries) {
        const summaryIds = (monthSummaries as Array<{ id: string; date: string }>).map((s) => s.id)
        const { data: monthAssignments } = await supabase
          .from('daily_summary_highlights')
          .select('daily_summary_id, rating')
          .in('daily_summary_id', summaryIds)
        
        if (monthAssignments) {
          const assignmentsByDate = new Map<string, Array<{ rating: number | null }>>()
          for (const assignment of monthAssignments as Array<{ daily_summary_id: string; rating: number | null }>) {
            const summary = (monthSummaries as Array<{ id: string; date: string }>).find((s) => s.id === assignment.daily_summary_id)
            if (summary) {
              if (!assignmentsByDate.has(summary.date)) {
                assignmentsByDate.set(summary.date, [])
              }
              assignmentsByDate.get(summary.date)!.push({ rating: assignment.rating })
            }
          }
          
          // Find completed days
          for (const [date, dateAssignments] of assignmentsByDate.entries()) {
            const totalHighlights = dateAssignments.length
            const ratedHighlights = dateAssignments.filter((a) => a.rating !== null).length
            if (totalHighlights > 0 && ratedHighlights === totalHighlights) {
              completedDays.add(date)
            }
          }
        }
      }
      
      // Build list of remaining days (from tomorrow to end of month, excluding completed days)
      for (let day = dayOfMonth + 1; day <= daysInMonth; day++) {
        const dayDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        if (!completedDays.has(dayDate)) {
          remainingDays.push(day)
        }
      }
      
      if (remainingDays.length > 0) {
        // First, check which highlights are already assigned to remaining days
        // We should only reassign highlights that aren't already assigned elsewhere
        const remainingDayDates = remainingDays.map((day) => 
          `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        )
        
        const { data: existingRemainingSummaries } = await supabase
          .from('daily_summaries')
          .select('id, date')
          .eq('user_id', user.id)
          .in('date', remainingDayDates)
        
        const alreadyAssignedHighlightIds = new Set<string>()
        if (existingRemainingSummaries && existingRemainingSummaries.length > 0) {
          const remainingSummaryIds = (existingRemainingSummaries as Array<{ id: string }>).map((s) => s.id)
          const { data: existingAssignments } = await supabase
            .from('daily_summary_highlights')
            .select('highlight_id')
            .in('daily_summary_id', remainingSummaryIds)
            .in('highlight_id', highlightIdsToReassign)
          
          if (existingAssignments) {
            for (const assignment of existingAssignments as Array<{ highlight_id: string }>) {
              alreadyAssignedHighlightIds.add(assignment.highlight_id)
            }
          }
        }
        
        // Filter out highlights that are already assigned to remaining days
        const highlightsToReassign = highlightIdsToReassign.filter(
          (id) => !alreadyAssignedHighlightIds.has(id)
        )
        
        if (highlightsToReassign.length === 0) {
          // All highlights are already assigned to remaining days, nothing to reassign
          return NextResponse.json({
            message: `Removed ${idsToRemove.length} unrated highlight(s) from ${date}. All highlights were already assigned to remaining days.`,
            removedCount: idsToRemove.length,
            reassignedCount: 0,
            totalHighlights: allAssignments.length,
            ratedHighlights: highlightsWithRatings.length,
            unratedHighlights: highlightsWithoutRatings.length,
            remainingHighlights: highlightsWithRatings.length,
          })
        }
        
        // Get highlight data for reassignment (only for highlights that need reassignment)
        const { data: highlightsData, error: highlightsError } = await supabase
          .from('highlights')
          .select('id, text, html_content')
          .in('id', highlightsToReassign)
          .eq('user_id', user.id)
          .eq('archived', false)
        
        if (highlightsError) throw highlightsError
        
        if (highlightsData && highlightsData.length > 0) {
          // Calculate scores for bin-packing
          const highlightsWithScore = highlightsData.map((h: any) => {
            const content = h.html_content || h.text || ''
            const plainText = content.replace(/<[^>]*>/g, '')
            return {
              id: h.id,
              text: h.text,
              html_content: h.html_content,
              score: plainText.length,
            }
          })
          
          // Seeded shuffle function
          const seededShuffle = <T,>(array: T[], seed: number): T[] => {
            const shuffled = [...array]
            let random = seed
            const seededRandom = () => {
              random = (random * 9301 + 49297) % 233280
              return random / 233280
            }
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(seededRandom() * (i + 1))
              ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
            }
            return shuffled
          }
          
          // Assign using bin-packing
          const seed = year * 100 + month
          const shuffledHighlights = seededShuffle(highlightsWithScore, seed)
          const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)
          
          const days: Array<{ day: number; highlights: typeof highlightsWithScore; totalScore: number }> = 
            remainingDays.map((day) => ({ day, highlights: [], totalScore: 0 }))
          
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

          // Shuffle highlights within each day so order is random, not longest-to-shortest
          for (const d of days) {
            d.highlights = seededShuffle(d.highlights, (seed + d.day) >>> 0)
          }
          
          // Create assignments
          for (const dayAssignment of days) {
            if (dayAssignment.highlights.length === 0) continue
            
            const dayDate = `${year}-${String(month).padStart(2, '0')}-${String(dayAssignment.day).padStart(2, '0')}`
            
            // Get or create summary for this day
            let summaryId: string | null = null
            const existingSummary = (monthSummaries as Array<{ id: string; date: string }> | null)?.find((s) => s.date === dayDate)
            
            if (existingSummary) {
              summaryId = existingSummary.id
            } else {
              const { data: newSummary, error: summaryError } = await (supabase
                .from('daily_summaries') as any)
                .insert([{ date: dayDate, user_id: user.id }])
                .select()
                .single()
              
              if (summaryError) throw summaryError
              summaryId = newSummary.id
            }
            
            if (summaryId) {
              // Check which highlights are already assigned to this summary
              const { data: existingAssignments } = await supabase
                .from('daily_summary_highlights')
                .select('highlight_id')
                .eq('daily_summary_id', summaryId)
                .in('highlight_id', dayAssignment.highlights.map((h) => h.id))
              
              const existingHighlightIds = new Set(
                (existingAssignments || []).map((a: any) => a.highlight_id)
              )
              
              // Only insert highlights that aren't already assigned
              const newHighlights = dayAssignment.highlights.filter(
                (h) => !existingHighlightIds.has(h.id)
              )
              
              if (newHighlights.length > 0) {
                const summaryHighlights = newHighlights.map((h) => ({
                  daily_summary_id: summaryId,
                  highlight_id: h.id,
                }))
                
                const { error: insertError } = await (supabase
                  .from('daily_summary_highlights') as any)
                  .insert(summaryHighlights)
                
                if (insertError) throw insertError
                reassignedCount += newHighlights.length
              }
            }
          }
        }
      }
    }

    return NextResponse.json({
      message: `Removed ${idsToRemove.length} unrated highlight(s) from ${date}${reassignedCount > 0 ? ` and reassigned ${reassignedCount} to remaining days in the month` : ''}`,
      removedCount: idsToRemove.length,
      reassignedCount,
      totalHighlights: allAssignments.length,
      ratedHighlights: highlightsWithRatings.length,
      unratedHighlights: highlightsWithoutRatings.length,
      remainingHighlights: highlightsWithRatings.length,
    })
  } catch (error: any) {
    console.error('Error cleaning up daily summary:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to cleanup daily summary' },
      { status: 500 }
    )
  }
}
