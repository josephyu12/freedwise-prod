import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { format } from 'date-fns'
import { Database } from '@/types/database'
import { getUserReviewSettings, getCycleForDate } from '@/lib/cycle'
import { verifyWidgetToken } from '@/lib/widgetToken'

// GET: Single endpoint for the Scriptable widget
// Accepts a signed widget token, verifies it, fetches the next highlight
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')
    const dateParam = request.nextUrl.searchParams.get('date')

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }

    const claims = verifyWidgetToken(token)

    if (!claims) {
      return NextResponse.json(
        { error: 'Invalid token', tokenExpired: true },
        { status: 401 }
      )
    }
    const userId = claims.userId

    // Use service role client — safe because we verified the user via HMAC
    const supabase = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Revocation check: the token must carry the user's CURRENT token version
    // (DELETE /api/widget-token bumps it to kill every outstanding token).
    // Missing row / table not migrated yet reads as version 1.
    const { data: widgetSettings, error: wsError } = await supabase
      .from('user_widget_settings')
      .select('token_version')
      .eq('user_id', userId)
      .maybeSingle()
    if (wsError) {
      const code = (wsError as { code?: string })?.code
      if (code !== '42P01' && code !== 'PGRST205') throw wsError
    }
    const currentVersion = (widgetSettings as { token_version?: number } | null)?.token_version ?? 1
    if (claims.tokenVersion !== currentVersion) {
      // tokenExpired makes the widget clear its keychain copy and prompt re-setup.
      return NextResponse.json(
        { error: 'Token revoked', tokenExpired: true },
        { status: 401 }
      )
    }

    // Use date from client (their local timezone) or fall back to server time
    const today = dateParam || format(new Date(), 'yyyy-MM-dd')

    // Daily review off: render a calm "off" state, not stale assignments.
    const { freq, enabled } = await getUserReviewSettings(supabase, userId)
    if (!enabled) {
      return NextResponse.json({ highlight: null, total: 0, reviewed: 0, enabled: false, allDone: true })
    }

    // Get today's daily summary
    const { data: summaryData, error: summaryError } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('date', today)
      .eq('user_id', userId)
      .maybeSingle()

    if (summaryError) throw summaryError

    if (!summaryData) {
      return NextResponse.json({
        highlight: null,
        total: 0,
        reviewed: 0,
      })
    }

    const summary = summaryData as { id: string }

    // Count only reviewable highlights: non-archived and not orphaned
    // (highlights!inner drops rows whose highlight was deleted). This MUST match
    // the archived/inner filter on the "next highlight" queries below. Counting
    // raw daily_summary_highlights rows instead let an archived or deleted
    // highlight inflate `total` (the denominator) while never being presentable
    // for review — stranding the widget at e.g. 45/46 forever.
    const { data: allHighlights, error: allError } = await supabase
      .from('daily_summary_highlights')
      .select('id, rating, highlight:highlights!inner(id, archived)')
      .eq('daily_summary_id', summary.id)
      .eq('highlight.archived', false)

    if (allError) throw allError

    const total = (allHighlights || []).length
    const reviewed = (allHighlights || []).filter(
      (h: any) => h.rating !== null
    ).length

    // Get unrated highlights
    const { data: unratedHighlights, error: nextError } = await supabase
      .from('daily_summary_highlights')
      .select(
        `
        id,
        highlight_id,
        highlight:highlights!inner (
          id,
          text,
          html_content,
          source,
          author,
          archived
        )
      `
      )
      .eq('daily_summary_id', summary.id)
      .eq('highlight.archived', false)
      .is('rating', null)
      .order('id', { ascending: true })

    if (nextError) throw nextError

    if (!unratedHighlights || unratedHighlights.length === 0) {
      // Today is done — look for unrated highlights from earlier in the CYCLE
      const cycleStart = getCycleForDate(today, freq).startDate

      const { data: catchUp, error: catchUpError } = await supabase
        .from('daily_summary_highlights')
        .select(
          `
          id,
          highlight_id,
          daily_summary:daily_summaries!inner (
            id,
            date,
            user_id
          ),
          highlight:highlights!inner (
            id,
            text,
            html_content,
            source,
            author,
            archived
          )
        `
        )
        .eq('daily_summary.user_id', userId)
        .gte('daily_summary.date', cycleStart)
        .lt('daily_summary.date', today)
        .eq('highlight.archived', false)
        .is('rating', null)

      if (catchUpError) throw catchUpError

      if (!catchUp || catchUp.length === 0) {
        return NextResponse.json({
          highlight: null,
          total,
          reviewed,
          allDone: true,
        })
      }

      // Oldest date first, then shortest text within that date
      const sorted = (catchUp as any[]).slice().sort((a, b) => {
        const dateA = a.daily_summary?.date || ''
        const dateB = b.daily_summary?.date || ''
        if (dateA !== dateB) return dateA < dateB ? -1 : 1
        const lenA = a.highlight?.text?.length || Infinity
        const lenB = b.highlight?.text?.length || Infinity
        return lenA - lenB
      })
      const pick = sorted[0]

      return NextResponse.json({
        highlight: {
          summaryHighlightId: pick.id,
          highlightId: pick.highlight_id,
          text: pick.highlight?.text || '',
          htmlContent: pick.highlight?.html_content || null,
          source: pick.highlight?.source || null,
          author: pick.highlight?.author || null,
        },
        total,
        reviewed,
        allDone: false,
        catchUpDate: pick.daily_summary?.date || null,
      })
    }

    // Pick the shortest highlight by text length
    const shortest = (unratedHighlights as any[]).reduce(
      (shortest, current) => {
        const shortestLen = shortest.highlight?.text?.length || Infinity
        const currentLen = current.highlight?.text?.length || Infinity
        return currentLen < shortestLen ? current : shortest
      }
    )

    return NextResponse.json({
      highlight: {
        summaryHighlightId: shortest.id,
        highlightId: shortest.highlight_id,
        text: shortest.highlight?.text || '',
        htmlContent: shortest.highlight?.html_content || null,
        source: shortest.highlight?.source || null,
        author: shortest.highlight?.author || null,
      },
      total,
      reviewed,
      allDone: false,
    })
  } catch (error: any) {
    console.error('Widget API error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch highlight' },
      { status: 500 }
    )
  }
}
