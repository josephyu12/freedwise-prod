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

    // One atomic RPC (see migration_schedule_rpcs.sql): the cycle's assignment
    // rows, its summaries, and its reviewed-ledger entries go together or not
    // at all — no more partially-reset cycles when a step failed mid-sequence.
    const { error: rpcError } = await (supabase.rpc as any)('reset_cycle', {
      p_cycle_start: cycle.startDate,
      p_cycle_end: cycle.endDate,
      p_cycle_key: cycle.key,
    })
    if (rpcError) throw rpcError

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
