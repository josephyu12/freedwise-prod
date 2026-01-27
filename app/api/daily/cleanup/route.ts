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

    if (idsToRemove.length === 0) {
      return NextResponse.json({
        message: `No unrated highlights to remove for ${date}. All ${allAssignments.length} highlights have ratings.`,
        removedCount: 0,
        totalHighlights: allAssignments.length,
        ratedHighlights: highlightsWithRatings.length,
      })
    }

    // Remove unrated highlights
    const { error: deleteError } = await supabase
      .from('daily_summary_highlights')
      .delete()
      .in('id', idsToRemove)

    if (deleteError) throw deleteError

    return NextResponse.json({
      message: `Removed ${idsToRemove.length} unrated highlight(s) from ${date}`,
      removedCount: idsToRemove.length,
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
