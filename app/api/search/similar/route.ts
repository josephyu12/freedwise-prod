import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Cosine floor for highlight -> highlight similarity (gte-small vectors).
// Tuned empirically: 0.85 is the 99th percentile of similarity between
// RANDOM highlight pairs in the real library, so everything above it is
// meaningfully related, not noise.
const SIMILAR_MIN_SIMILARITY = 0.85
const SIMILAR_COUNT = 10

// Enrich highlight with current month's assigned_date (for "Review on" tags). Uses server's now so it updates when month rolls over.
function enrichWithAssignedDate(h: any): any {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const currentMonthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const currentMonthEnd = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
  let assigned_date: string | null = null
  if (h.daily_assignments && Array.isArray(h.daily_assignments) && h.daily_assignments.length > 0) {
    const currentMonthAssignment = h.daily_assignments.find((da: any) => {
      const d = da.daily_summary?.date
      if (!d) return false
      return d >= currentMonthStart && d <= currentMonthEnd
    })
    if (currentMonthAssignment?.daily_summary?.date) {
      assigned_date = currentMonthAssignment.daily_summary.date
    }
  }
  const { daily_assignments, embedding, embedding_hash, ...rest } = h
  return { ...rest, assigned_date }
}

const dailyAssignmentsSelect = 'daily_assignments:daily_summary_highlights(id,daily_summary:daily_summaries(id,date))'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Defense-in-depth: scope every read to the authenticated user explicitly,
    // in addition to RLS. A request without a valid session is rejected outright.
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { highlightId } = await request.json()

    if (!highlightId || typeof highlightId !== 'string') {
      return NextResponse.json(
        { error: 'Highlight ID is required' },
        { status: 400 }
      )
    }

    // Nearest neighbors of the stored embedding, via pgvector. Covers the
    // whole library; returns empty when the source highlight has no
    // embedding yet (brand-new row awaiting the client sync pass).
    const { data: matches, error: matchError } = await (supabase as any)
      .rpc('similar_highlights', {
        p_highlight_id: highlightId,
        match_count: SIMILAR_COUNT,
        min_similarity: SIMILAR_MIN_SIMILARITY,
      })
    if (matchError) throw matchError

    const ranked: { id: string; similarity: number }[] = matches || []
    if (ranked.length === 0) {
      return NextResponse.json({ similar: [] })
    }

    const { data: details, error: detailError } = await supabase
      .from('highlights')
      .select(`
        *,
        highlight_categories (
          category:categories (*)
        ),
        highlight_links_from:highlight_links!from_highlight_id (
          id,
          to_highlight_id,
          link_text,
          to_highlight:highlights!to_highlight_id (
            id,
            text,
            source,
            author
          )
        ),
        ${dailyAssignmentsSelect}
      `)
      .in('id', ranked.map((m) => m.id))
      .eq('user_id', user.id)
      .eq('archived', false)
    if (detailError) throw detailError

    const byId = new Map((details || []).map((h: any) => [h.id, h]))
    const similar = ranked
      .filter((m) => byId.has(m.id))
      .map((m) =>
        enrichWithAssignedDate({
          ...(byId.get(m.id) as any),
          similarity: m.similarity,
          categories: (byId.get(m.id) as any).highlight_categories?.map((hc: any) => hc.category) || [],
          linked_highlights: (byId.get(m.id) as any).highlight_links_from || [],
        })
      )

    return NextResponse.json({ similar })
  } catch (error: any) {
    console.error('Error finding similar highlights:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to find similar highlights' },
      { status: 500 }
    )
  }
}
