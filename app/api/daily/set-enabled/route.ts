import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/daily/set-enabled
 * Body { enabled: boolean }
 *
 * Turns daily review on or off. This is a PURE FLAG TOGGLE — it never touches
 * daily_summaries / daily_summary_highlights. Off→on is therefore a no-op for
 * scheduling: every highlight stays assigned to exactly the day it was on before.
 *
 * While off, the daily/review/widget surfaces render a calm "off" state (they
 * read daily_review_enabled), so the existing assignments are simply hidden, not
 * deleted — nothing is stale, nothing is lost, and re-enabling restores the exact
 * prior layout. (New highlights added while off aren't placed until review is on
 * again, matching the "review is paused" intent.)
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let enabled = true
    try {
      const body = await request.json().catch(() => ({}))
      enabled = (body as { enabled?: boolean }).enabled !== false
    } catch {
      /* default enabled */
    }

    const { error: upsertErr } = await (supabase.from('user_review_settings') as any)
      .upsert({ user_id: user.id, daily_review_enabled: enabled }, { onConflict: 'user_id' })
    if (upsertErr) throw upsertErr

    return NextResponse.json({ enabled })
  } catch (error: any) {
    console.error('Error setting daily-review enabled:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to update setting' },
      { status: 500 }
    )
  }
}
