import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { format } from 'date-fns'

// GET: Get the next unrated highlight for today's daily summary
// Used by the Scriptable widget to display a highlight
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

    // Get first unrated highlight with full details
    const { data: nextHighlight, error: nextError } = await supabase
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
      .limit(1)
      .maybeSingle()

    if (nextError) throw nextError

    if (!nextHighlight) {
      return NextResponse.json({ highlight: null, total, reviewed, allDone: true })
    }

    const nh = nextHighlight as any

    return NextResponse.json({
      highlight: {
        summaryHighlightId: nh.id,
        highlightId: nh.highlight_id,
        text: nh.highlight?.text || '',
        htmlContent: nh.highlight?.html_content || null,
        source: nh.highlight?.source || null,
        author: nh.highlight?.author || null,
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
