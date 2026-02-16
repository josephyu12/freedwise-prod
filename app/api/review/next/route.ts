import { createClient } from '@/lib/supabase/server'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { format } from 'date-fns'
import { Database } from '@/types/database'

// GET: Get the next unrated highlight for today's daily summary
// Supports cookie auth (browser) and Bearer token auth (widget)
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
      return NextResponse.json({ highlight: null, total: 0, reviewed: 0 })
    }

    const summary = summaryData as { id: string }

    // Get all highlights for the summary
    const { data: allHighlights, error: allError } = await supabase
      .from('daily_summary_highlights')
      .select('id, highlight_id, rating')
      .eq('daily_summary_id', summary.id)

    if (allError) throw allError

    const total = (allHighlights || []).length
    const reviewed = (allHighlights || []).filter((h: any) => h.rating !== null).length

    // Get all unrated highlights, then pick the shortest one
    const { data: unratedHighlights, error: nextError } = await supabase
      .from('daily_summary_highlights')
      .select(`
        id,
        highlight_id,
        highlight:highlights (
          id,
          text,
          html_content,
          source,
          author
        )
      `)
      .eq('daily_summary_id', summary.id)
      .is('rating', null)
      .order('id', { ascending: true })

    if (nextError) throw nextError

    if (!unratedHighlights || unratedHighlights.length === 0) {
      return NextResponse.json({ highlight: null, total, reviewed, allDone: true })
    }

    // Pick the shortest highlight by text length
    const shortest = (unratedHighlights as any[]).reduce((shortest, current) => {
      const shortestLen = shortest.highlight?.text?.length || Infinity
      const currentLen = current.highlight?.text?.length || Infinity
      return currentLen < shortestLen ? current : shortest
    })

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
    console.error('Error fetching next highlight:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch next highlight' },
      { status: 500 }
    )
  }
}
