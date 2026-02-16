import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { format } from 'date-fns'
import { Database } from '@/types/database'

// GET: Single endpoint for the Scriptable widget
// Accepts a refresh_token, exchanges it server-side, fetches the next highlight
export async function GET(request: NextRequest) {
  try {
    const refreshToken = request.nextUrl.searchParams.get('token')

    if (!refreshToken) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }

    // Create a Supabase client with the service role key for auth operations,
    // but we'll use the user's token for RLS queries
    const supabaseAuth = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: { getAll: () => [], setAll: () => {} },
      }
    )

    // Exchange refresh token for a new session
    const { data: sessionData, error: sessionError } =
      await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken })

    if (sessionError || !sessionData.session) {
      return NextResponse.json(
        { error: 'Token expired', tokenExpired: true },
        { status: 401 }
      )
    }

    const session = sessionData.session
    const user = session.user

    // Now create a client authenticated as this user for RLS queries
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: { getAll: () => [], setAll: () => {} },
        global: {
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      }
    )

    const today = format(new Date(), 'yyyy-MM-dd')

    // Get today's daily summary
    const { data: summaryData, error: summaryError } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('date', today)
      .eq('user_id', user.id)
      .maybeSingle()

    if (summaryError) throw summaryError

    if (!summaryData) {
      return NextResponse.json({
        highlight: null,
        total: 0,
        reviewed: 0,
        newRefreshToken: session.refresh_token,
      })
    }

    const summary = summaryData as { id: string }

    // Get all highlights for the summary
    const { data: allHighlights, error: allError } = await supabase
      .from('daily_summary_highlights')
      .select('id, highlight_id, rating')
      .eq('daily_summary_id', summary.id)

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
        highlight:highlights (
          id,
          text,
          html_content,
          source,
          author
        )
      `
      )
      .eq('daily_summary_id', summary.id)
      .is('rating', null)
      .order('id', { ascending: true })

    if (nextError) throw nextError

    if (!unratedHighlights || unratedHighlights.length === 0) {
      return NextResponse.json({
        highlight: null,
        total,
        reviewed,
        allDone: true,
        newRefreshToken: session.refresh_token,
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
      newRefreshToken: session.refresh_token,
    })
  } catch (error: any) {
    console.error('Widget API error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch highlight' },
      { status: 500 }
    )
  }
}
