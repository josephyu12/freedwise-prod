import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getCycleForDate, nextCycle, cycleSeed, getUserReviewSettings } from '@/lib/cycle'
import { packIntoDates, Scored } from '@/lib/binPack'

/**
 * GET /api/daily/prepare-next-cycle
 *
 * Runs DAILY (Vercel cron). With per-user frequencies, cycle boundaries differ
 * between users, so the "is it time?" decision is made inside the route per user
 * rather than by a fixed monthly schedule:
 *   1. Read the user's { freq, enabled }. If review is OFF, skip the user.
 *   2. current = cycle containing today; next = the cycle after it.
 *   3. Only portion `next` when today is within LEAD_DAYS of current.endDate AND
 *      `next` has no daily_summaries yet (idempotency — the daily job must not
 *      re-portion the upcoming cycle every day).
 *
 * For freq=1 this reproduces the old monthly job (prepare next month in the last
 * week), just triggered by a daily heartbeat — strictly more robust.
 */

const LEAD_DAYS = 7
const pad = (n: number) => String(n).padStart(2, '0')

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(`${aIso}T00:00:00Z`).getTime()
  const b = new Date(`${bIso}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86400000)
}

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  console.log('[PREPARE-NEXT-CYCLE] Starting cron job execution')

  try {
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      console.error('[PREPARE-NEXT-CYCLE] CRON_SECRET is not set — refusing to run.')
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
    }

    const authHeader = request.headers.get('authorization')
    const secretParam = request.nextUrl.searchParams.get('secret')
    const testUserId = request.nextUrl.searchParams.get('userId')

    const isAuthorized = authHeader === `Bearer ${cronSecret}` || secretParam === cronSecret
    if (!isAuthorized) {
      console.error('[PREPARE-NEXT-CYCLE] Unauthorized access attempt')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'Service role key not configured' }, { status: 500 })
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return NextResponse.json({ error: 'Supabase URL not configured' }, { status: 500 })
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Server "today" (UTC). The lead window is 7 days wide, so being off by an
    // hour at a timezone boundary is harmless.
    const now = new Date()
    const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`

    // All users with at least one unarchived highlight (paginate).
    const USER_PAGE = 1000
    const allUserIds = new Set<string>()
    let userFrom = 0
    while (true) {
      const { data: userPage, error: usersError } = await supabase
        .from('highlights')
        .select('user_id')
        .eq('archived', false)
        .range(userFrom, userFrom + USER_PAGE - 1)
      if (usersError) throw usersError
      const page = (userPage || []) as Array<{ user_id: string }>
      for (const h of page) allUserIds.add(h.user_id)
      if (page.length < USER_PAGE) break
      userFrom += USER_PAGE
    }

    let userIds = Array.from(allUserIds)
    if (testUserId) {
      userIds = [testUserId]
    }

    const results = {
      totalUsers: userIds.length,
      portioned: 0,
      skippedDisabled: 0,
      skippedNotDue: 0,
      skippedAlreadyDone: 0,
      failed: 0,
      errors: [] as string[],
    }

    const PAGE = 1000

    for (const userId of userIds) {
      try {
        const { freq, enabled } = await getUserReviewSettings(supabase, userId)
        if (!enabled) {
          results.skippedDisabled++
          continue
        }

        const current = getCycleForDate(today, freq)
        const next = nextCycle(current)

        // (a) Only act in the lead window before the current cycle ends.
        if (daysBetween(today, current.endDate) > LEAD_DAYS) {
          results.skippedNotDue++
          continue
        }

        // (b) Idempotency: skip if next cycle already has summaries.
        const { data: nextSummaries, error: nextErr } = await supabase
          .from('daily_summaries')
          .select('id')
          .eq('user_id', userId)
          .gte('date', next.startDate)
          .lte('date', next.endDate)
          .limit(1)
        if (nextErr) throw nextErr
        if (nextSummaries && nextSummaries.length > 0) {
          results.skippedAlreadyDone++
          continue
        }

        // Fetch unarchived highlights (paginate).
        let allHighlightsData: Array<{ id: string; text: string; html_content: string | null }> = []
        let from = 0
        while (true) {
          const { data, error: pageError } = await supabase
            .from('highlights')
            .select('id, text, html_content')
            .eq('user_id', userId)
            .eq('archived', false)
            .range(from, from + PAGE - 1)
          if (pageError) throw pageError
          const page = (data || []) as Array<{ id: string; text: string; html_content: string | null }>
          allHighlightsData = allHighlightsData.concat(page)
          if (page.length < PAGE) break
          from += PAGE
        }

        // Exclude highlights already reviewed for the next cycle (paginate).
        const reviewedHighlightIds = new Set<string>()
        let revFrom = 0
        while (true) {
          const { data: reviewedPage, error: reviewedError } = await supabase
            .from('highlight_months_reviewed')
            .select('highlight_id')
            .eq('month_year', next.key)
            .range(revFrom, revFrom + PAGE - 1)
          if (reviewedError) throw reviewedError
          const revPage = (reviewedPage || []) as Array<{ highlight_id: string }>
          for (const r of revPage) reviewedHighlightIds.add(r.highlight_id)
          if (revPage.length < PAGE) break
          revFrom += PAGE
        }

        const highlights = allHighlightsData.filter((h) => !reviewedHighlightIds.has(h.id))
        if (highlights.length === 0) {
          results.skippedAlreadyDone++
          continue
        }

        const scored: Scored[] = highlights.map((h) => {
          const content = h.html_content || h.text || ''
          return {
            id: h.id,
            text: h.text,
            html_content: h.html_content,
            score: content.replace(/<[^>]*>/g, '').length,
          }
        })

        const buckets = packIntoDates(scored, next.dates, cycleSeed(next))

        for (const bucket of buckets) {
          if (bucket.highlights.length === 0) continue
          const { data: summaryData, error: summaryError } = await supabase
            .from('daily_summaries')
            .insert([{ date: bucket.date, user_id: userId }])
            .select()
            .single()
          if (summaryError) throw summaryError
          const { error: linkError } = await supabase
            .from('daily_summary_highlights')
            .insert(bucket.highlights.map((h) => ({ daily_summary_id: summaryData.id, highlight_id: h.id })))
          if (linkError) throw linkError
        }

        results.portioned++
      } catch (error: any) {
        results.failed++
        results.errors.push(`User ${userId}: ${error.message || 'Unknown error'}`)
        console.error(`[PREPARE-NEXT-CYCLE] Error for user ${userId}:`, error)
      }
    }

    const totalDuration = Date.now() - startTime
    console.log(`[PREPARE-NEXT-CYCLE] Completed in ${totalDuration}ms.`, results)

    return NextResponse.json({
      message: 'Prepared next cycles where due',
      today,
      duration: `${totalDuration}ms`,
      results,
      testMode: !!testUserId,
    })
  } catch (error: any) {
    const totalDuration = Date.now() - startTime
    console.error(`[PREPARE-NEXT-CYCLE] Fatal error after ${totalDuration}ms:`, error)
    return NextResponse.json(
      { error: error.message || 'Failed to prepare next cycle', duration: `${totalDuration}ms` },
      { status: 500 }
    )
  }
}
