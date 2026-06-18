import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCycleForDate, getUserReviewSettings } from '@/lib/cycle'

/**
 * POST /api/daily/reset-cycle
 * Resets all daily highlights for the CURRENT review cycle:
 * - Removes all ratings (deletes daily_summary_highlights + daily_summaries in
 *   the cycle window).
 * - Removes the "reviewed" ledger rows for the cycle key (highlight_months_reviewed).
 * Does NOT reassign; caller should call /api/daily/assign afterward.
 *
 * Body { localDate? } — the client's YYYY-MM-DD so the cycle is resolved in the
 * user's timezone (falls back to server UTC).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let localDate: string | null = null
    try {
      const body = await request.json().catch(() => ({}))
      if (typeof (body as { localDate?: unknown }).localDate === 'string') {
        localDate = (body as { localDate: string }).localDate
      }
    } catch {
      /* ignore */
    }

    const now = new Date()
    const today = localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)
      ? localDate
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    const { freq } = await getUserReviewSettings(supabase, user.id)
    const cycle = getCycleForDate(today, freq)

    // 1. Delete daily_summary_highlights for this cycle's summaries.
    const { data: summaries, error: sumErr } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('date', cycle.startDate)
      .lte('date', cycle.endDate)
    if (sumErr) throw sumErr

    const summaryIds = (summaries || []).map((s: { id: string }) => s.id)
    if (summaryIds.length > 0) {
      await supabase.from('daily_summary_highlights').delete().in('daily_summary_id', summaryIds)
    }

    // 2. Delete the daily_summaries themselves.
    await supabase
      .from('daily_summaries')
      .delete()
      .eq('user_id', user.id)
      .gte('date', cycle.startDate)
      .lte('date', cycle.endDate)

    // 3. Remove the "reviewed" ledger rows for this cycle key (chunked).
    const { data: userHighlightIds } = await supabase
      .from('highlights')
      .select('id')
      .eq('user_id', user.id)
    const highlightIds = (userHighlightIds || []).map((h: { id: string }) => h.id)
    if (highlightIds.length > 0) {
      const chunk = 200
      for (let i = 0; i < highlightIds.length; i += chunk) {
        const slice = highlightIds.slice(i, i + chunk)
        await supabase
          .from('highlight_months_reviewed')
          .delete()
          .eq('month_year', cycle.key)
          .in('highlight_id', slice)
      }
    }

    return NextResponse.json({
      message: `Reset complete for cycle ${cycle.key}. Call /api/daily/assign to reassign highlights.`,
      cycleKey: cycle.key,
    })
  } catch (error: any) {
    console.error('Error resetting cycle:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to reset cycle' },
      { status: 500 }
    )
  }
}
