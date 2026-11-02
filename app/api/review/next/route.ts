import { createClient } from '@/lib/supabase/server'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { format } from 'date-fns'
import { Database } from '@/types/database'
import { getUserReviewSettings } from '@/lib/cycle'
import { loadReviewQueue } from '@/lib/reviewQueue'

// GET: Get the next unrated highlight for today's daily summary
// Supports cookie auth (browser) and Bearer token auth (widget)
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    let supabase
    let user

    // Check for Bearer token auth (from Scriptable widget)
    const authHeader = request.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      // Create a Supabase client and verify the token
      supabase = createServerClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: { getAll: () => [], setAll: () => {} },
          global: { headers: { Authorization: `Bearer ${token}` } },
        }
      )
      const { data, error } = await supabase.auth.getUser(token)
      if (error || !data.user) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      }
      user = data.user
    } else {
      // Cookie-based auth (browser)
      supabase = await createClient()
      const { data, error } = await supabase.auth.getUser()
      if (error || !data.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      user = data.user
    }

    // Use the date from the client (their local timezone) when provided, else
    // fall back to server time. A bare server `new Date()` resolves in the
    // host's UTC, which rolls the day over hours early for users in the
    // Americas and surfaces the wrong day's summary at night. Matches the
    // convention in app/api/review/widget/route.ts.
    const dateParam = request.nextUrl.searchParams.get('date')
    const today = dateParam || format(new Date(), 'yyyy-MM-dd')

    // Daily review off: return nothing (calm "off" state), not stale assignments.
    const { enabled } = await getUserReviewSettings(supabase, user.id)
    if (!enabled) {
      return NextResponse.json({ highlight: null, total: 0, reviewed: 0, enabled: false, allDone: true })
    }

    return NextResponse.json(await loadReviewQueue(supabase, user.id, today, today), {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })

  } catch (error: any) {
    console.error('Error fetching next highlight:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch next highlight' },
      { status: 500 }
    )
  }
}
