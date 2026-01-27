import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/daily/reset-month
 * Resets all daily highlights for the current month:
 * - Removes all ratings (by deleting daily_summary_highlights and daily_summaries)
 * - Removes all "reviewed" entries for the month (highlight_months_reviewed)
 * Does NOT reassign; caller should call /api/daily/assign after this.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const daysInMonth = new Date(year, month, 0).getDate()
    const monthYear = `${year}-${String(month).padStart(2, '0')}`
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`

    // 1. Get user's daily summaries for this month
    const { data: summaries, error: sumErr } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('date', startDate)
      .lte('date', endDate)

    if (sumErr) throw sumErr

    const summaryIds = (summaries || []).map((s: { id: string }) => s.id)

    // 2. Delete daily_summary_highlights for these summaries (removes all ratings)
    if (summaryIds.length > 0) {
      await supabase
        .from('daily_summary_highlights')
        .delete()
        .in('daily_summary_id', summaryIds)
    }

    // 3. Delete daily_summaries for this month
    await supabase
      .from('daily_summaries')
      .delete()
      .eq('user_id', user.id)
      .gte('date', startDate)
      .lte('date', endDate)

    // 4. Remove "reviewed" status for this month (all of user's highlights)
    const { data: userHighlightIds } = await supabase
      .from('highlights')
      .select('id')
      .eq('user_id', user.id)

    const highlightIds = (userHighlightIds || []).map((h: { id: string }) => h.id)
    if (highlightIds.length > 0) {
      // Delete in chunks to avoid query size limits
      const chunk = 200
      for (let i = 0; i < highlightIds.length; i += chunk) {
        const slice = highlightIds.slice(i, i + chunk)
        await supabase
          .from('highlight_months_reviewed')
          .delete()
          .eq('month_year', monthYear)
          .in('highlight_id', slice)
      }
    }

    return NextResponse.json({
      message: `Reset complete for ${monthYear}. Call /api/daily/assign to reassign highlights.`,
      monthYear,
      year,
      month,
    })
  } catch (error: any) {
    console.error('Error resetting month:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to reset month' },
      { status: 500 }
    )
  }
}
