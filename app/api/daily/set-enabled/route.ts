import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCycleForDate, getUserReviewSettings } from '@/lib/cycle'

/**
 * POST /api/daily/set-enabled
 * Body { enabled: boolean, localDate?: string }
 *
 * Turns daily review on or off.
 *
 * OFF is a pure flag toggle — it never touches daily_summaries /
 * daily_summary_highlights. While off, the daily/review/widget surfaces render a
 * calm "off" state (they read daily_review_enabled), so existing assignments are
 * simply hidden, not deleted. New highlights added while off aren't placed until
 * review is on again, matching the "review is paused" intent.
 *
 * ON, additionally, clears STALE BACKLOG so re-enabling resumes from "now":
 * any cycle that ended before the current cycle (i.e. elapsed while review was
 * off) must not greet the user with a full set of unreviewed highlights still
 * "waiting". This happens because a cycle can be pre-portioned (by the daily
 * prepare-next-cycle cron, or the lazy next-cycle prep in /daily) right before
 * the user turned review off; those assignments would otherwise sit untouched
 * for months and light up the calendar as a backlog the moment review is on.
 *
 * So on enable we delete only the ENTIRELY-UNREVIEWED past days (summaries dated
 * before the current cycle's start with no rated highlight at all), dropping the
 * summary and its rows together. Days the user actually started — partial or
 * completed — are left COMPLETELY untouched, so the calendar only ever paints a
 * day green when it was genuinely finished; we never strip a partial day's
 * unrated remainder and thereby fake it into "completed". This also keeps the
 * critical invariant intact: a rated row and its highlight_months_reviewed
 * ledger entry are the permanent record of a review (see assign/route.ts) and
 * are never touched. The CURRENT (and any future) cycle is likewise left exactly
 * as it was, so a quick off→on within the same cycle is a no-op for scheduling.
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
      const rawDate = (body as { localDate?: unknown }).localDate
      if (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        localDate = rawDate
      }
    } catch {
      /* default enabled */
    }

    const { error: upsertErr } = await (supabase.from('user_review_settings') as any)
      .upsert({ user_id: user.id, daily_review_enabled: enabled }, { onConflict: 'user_id' })
    if (upsertErr) throw upsertErr

    let clearedBacklog = 0
    if (enabled) {
      clearedBacklog = await clearStaleBacklog(supabase, user.id, localDate)
    }

    return NextResponse.json({ enabled, clearedBacklog })
  } catch (error: any) {
    console.error('Error setting daily-review enabled:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to update setting' },
      { status: 500 }
    )
  }
}

/**
 * Remove the entirely-unreviewed days left in cycles that ended before the
 * current one (the months that elapsed while review was off). A past day is
 * cleared only when it holds NO rated highlight; days that were partly or fully
 * reviewed are left untouched so their calendar color stays truthful and every
 * rated row + its reviewed ledger entry is preserved. Returns the number of
 * unreviewed assignment rows deleted.
 */
async function clearStaleBacklog(
  supabase: any,
  userId: string,
  localDate: string | null
): Promise<number> {
  const now = new Date()
  const today = localDate
    ? localDate
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const { freq } = await getUserReviewSettings(supabase, userId)
  // Everything strictly before the current cycle's first day is "past" backlog.
  const cutoff = getCycleForDate(today, freq).startDate

  const PAGE = 1000
  const CHUNK = 500

  // All summaries that pre-date the current cycle.
  const pastSummaries: Array<{ id: string; date: string }> = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('user_id', userId)
      .lt('date', cutoff)
      .range(from, from + PAGE - 1)
    if (error) throw error
    const page = (data || []) as Array<{ id: string; date: string }>
    pastSummaries.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }
  if (pastSummaries.length === 0) return 0

  const pastIds = pastSummaries.map((s) => s.id)

  // Which past days have at least one rated highlight? Those are days the user
  // actually started (partial or completed) — leave them entirely alone.
  const ratedSummaryIds = new Set<string>()
  for (let i = 0; i < pastIds.length; i += CHUNK) {
    const chunk = pastIds.slice(i, i + CHUNK)
    let rowFrom = 0
    while (true) {
      const { data, error } = await supabase
        .from('daily_summary_highlights')
        .select('daily_summary_id')
        .in('daily_summary_id', chunk)
        .not('rating', 'is', null)
        .range(rowFrom, rowFrom + PAGE - 1)
      if (error) throw error
      const page = (data || []) as Array<{ daily_summary_id: string }>
      for (const r of page) ratedSummaryIds.add(r.daily_summary_id)
      if (page.length < PAGE) break
      rowFrom += PAGE
    }
  }

  // Entirely-unreviewed past days: drop their (all-unrated) rows, then the
  // summary itself so the calendar stops showing it as navigable backlog.
  const unreviewedIds = pastIds.filter((id) => !ratedSummaryIds.has(id))
  let deleted = 0
  for (let i = 0; i < unreviewedIds.length; i += CHUNK) {
    const chunk = unreviewedIds.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('daily_summary_highlights')
      .delete()
      .in('daily_summary_id', chunk)
      .select('id')
    if (error) throw error
    deleted += (data || []).length
  }
  for (let i = 0; i < unreviewedIds.length; i += CHUNK) {
    const chunk = unreviewedIds.slice(i, i + CHUNK)
    const { error } = await supabase.from('daily_summaries').delete().in('id', chunk)
    if (error) throw error
  }

  return deleted
}
