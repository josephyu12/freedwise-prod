import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { format } from 'date-fns'
import { Database } from '@/types/database'
import { getUserReviewSettings, getCycleForDate } from '@/lib/cycle'
import { verifyWidgetToken } from '@/lib/widgetToken'
import { loadReviewQueue } from '@/lib/reviewQueue'

// GET: Single endpoint for the Scriptable widget
// Accepts a signed widget token, verifies it, fetches the next highlight
export const dynamic = 'force-dynamic'
// In Next 14, a dynamic GET route can still reuse cached upstream fetches.
// This service-role client does not read cookies(), so explicitly bypass the
// Data Cache for ratings, review settings, and token-revocation checks.
export const fetchCache = 'force-no-store'

// Scriptable/iOS may cache GET responses independently of Next's route cache.
function widgetJson(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init, headers: { 'Cache-Control': 'private, no-store, max-age=0', ...init?.headers },
  })
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')
    const dateParam = request.nextUrl.searchParams.get('date')

    if (!token) {
      return widgetJson({ error: 'Missing token' }, { status: 400 })
    }

    const claims = verifyWidgetToken(token)

    if (!claims) {
      return widgetJson(
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
      return widgetJson(
        { error: 'Token revoked', tokenExpired: true },
        { status: 401 }
      )
    }

    // Use date from client (their local timezone) or fall back to server time
    const today = dateParam || format(new Date(), 'yyyy-MM-dd')

    // Daily review off: render a calm "off" state, not stale assignments.
    const { freq, enabled } = await getUserReviewSettings(supabase, userId)
    if (!enabled) {
      return widgetJson({ highlight: null, total: 0, reviewed: 0, enabled: false, allDone: true })
    }

    const cycleStart = getCycleForDate(today, freq).startDate
    return widgetJson(await loadReviewQueue(supabase, userId, today, cycleStart))

  } catch (error: any) {
    console.error('Widget API error:', error)
    return widgetJson(
      { error: error.message || 'Failed to fetch highlight' },
      { status: 500 }
    )
  }
}
