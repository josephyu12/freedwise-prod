import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/daily/set-enabled
 * Body { enabled: boolean, localDate?: string }
 *
 * Turns daily review on or off. Turning OFF clears FUTURE, UN-RATED assignments
 * (date >= today) so the calendar isn't left showing stale work — rated days and
 * the reviewed ledger are preserved, so re-enabling is lossless for history.
 * Turning ON only persists the flag; the caller re-portions the current cycle via
 * /api/daily/assign (which now passes the enabled guard).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let enabled = true
    let localDate: string | null = null
    try {
      const body = await request.json().catch(() => ({}))
      enabled = (body as { enabled?: boolean }).enabled !== false
      if (typeof (body as { localDate?: unknown }).localDate === 'string') {
        localDate = (body as { localDate: string }).localDate
      }
    } catch {
      /* defaults */
    }

    const now = new Date()
    const today = localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)
      ? localDate
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    const { error: upsertErr } = await (supabase.from('user_review_settings') as any)
      .upsert({ user_id: user.id, daily_review_enabled: enabled }, { onConflict: 'user_id' })
    if (upsertErr) throw upsertErr

    let clearedSummaries = 0
    if (!enabled) {
      // Clear future un-rated assignments (today onward); keep rated history.
      const { data: futureSummaries } = await supabase
        .from('daily_summaries')
        .select('id')
        .eq('user_id', user.id)
        .gte('date', today)
      const ids = (futureSummaries || []).map((s: { id: string }) => s.id)
      if (ids.length > 0) {
        await supabase
          .from('daily_summary_highlights')
          .delete()
          .in('daily_summary_id', ids)
          .is('rating', null)
        const { data: remaining } = await supabase
          .from('daily_summary_highlights')
          .select('daily_summary_id')
          .in('daily_summary_id', ids)
        const withRows = new Set((remaining || []).map((r: any) => r.daily_summary_id))
        const emptyIds = ids.filter((id) => !withRows.has(id))
        if (emptyIds.length > 0) {
          await supabase.from('daily_summaries').delete().in('id', emptyIds)
          clearedSummaries = emptyIds.length
        }
      }
    }

    return NextResponse.json({ enabled, clearedSummaries })
  } catch (error: any) {
    console.error('Error setting daily-review enabled:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to update setting' },
      { status: 500 }
    )
  }
}
