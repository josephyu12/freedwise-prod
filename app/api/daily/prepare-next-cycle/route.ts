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

// Portioning a yearly cycle for several users can exceed the default 10s
// serverless budget; give the cron the full Hobby-plan allowance.
export const maxDuration = 60

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

        // Fetch unarchived highlights (paginate; id + stored score only).
        let allHighlightsData: Array<{ id: string; score: number }> = []
        let from = 0
        while (true) {
          const { data, error: pageError } = await supabase
            .from('highlights')
            .select('id, score')
            .eq('user_id', userId)
            .eq('archived', false)
            .range(from, from + PAGE - 1)
          if (pageError) throw pageError
          const page = (data || []) as Array<{ id: string; score: number }>
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

        const scored: Scored[] = highlights.map((h) => ({ id: h.id, score: h.score }))

        const buckets = packIntoDates(scored, next.dates, cycleSeed(next))
        const nonEmpty = buckets.filter((b) => b.highlights.length > 0)
        if (nonEmpty.length === 0) {
          results.skippedAlreadyDone++
          continue
        }

        // Two-phase batched write instead of the old per-day insert loop (2
        // requests per day — up to ~730 for a yearly cycle). If that loop died
        // partway, the "next cycle already has summaries" idempotency check
        // above skipped the half-portioned cycle FOREVER. Batching shrinks the
        // failure window to a handful of requests, and the compensating delete
        // below returns the cycle to "no summaries" when the link phase fails,
        // so tomorrow's run simply retries from clean.
        const { data: summaryRows, error: summariesError } = await supabase
          .from('daily_summaries')
          .upsert(
            nonEmpty.map((b) => ({ date: b.date, user_id: userId })),
            { onConflict: 'date,user_id' }
          )
          .select('id, date')
        if (summariesError) throw summariesError
        const idByDate = new Map(
          ((summaryRows || []) as Array<{ id: string; date: string }>).map((s) => [s.date, s.id])
        )

        try {
          const links = nonEmpty.flatMap((b) => {
            const summaryId = idByDate.get(b.date)
            if (!summaryId) throw new Error(`No daily_summary id returned for ${b.date}`)
            return b.highlights.map((h) => ({ daily_summary_id: summaryId, highlight_id: h.id }))
          })
          const CHUNK = 500
          for (let i = 0; i < links.length; i += CHUNK) {
            const { error: linkError } = await supabase
              .from('daily_summary_highlights')
              .upsert(links.slice(i, i + CHUNK), {
                onConflict: 'daily_summary_id,highlight_id',
                ignoreDuplicates: true,
              })
            if (linkError) throw linkError
          }
        } catch (linkErr) {
          // Compensate: the idempotency check guaranteed the cycle had no
          // summaries before this run, so everything in it is ours — drop the
          // summaries (links cascade) to restore the retryable "no summaries"
          // state instead of leaving a permanently-skipped partial cycle.
          const { error: cleanupError } = await supabase
            .from('daily_summaries')
            .delete()
            .eq('user_id', userId)
            .gte('date', next.startDate)
            .lte('date', next.endDate)
          if (cleanupError) {
            console.error(
              `[PREPARE-NEXT-CYCLE] Cleanup after failed portioning ALSO failed for user ${userId}; cycle ${next.key} may be left partial:`,
              cleanupError
            )
          }
          throw linkErr
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
