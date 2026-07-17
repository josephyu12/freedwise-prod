import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const EMBEDDING_DIM = 384

// Cosine-similarity floor for query -> highlight matches (gte-small vectors).
// Tuned empirically against the real library: the median query->highlight
// similarity is ~0.78 (gte-small clusters high), clearly relevant matches
// land 0.83+. Drop this if semantic recall ever feels thin.
const SEMANTIC_MIN_SIMILARITY = 0.81
const SEMANTIC_MATCH_COUNT = 30
// Top matches become "results"; the tail becomes "similar".
const SEMANTIC_RESULTS_COUNT = 20

// Normalize months_reviewed: union the highlight_months_reviewed rows with months
// derived from rated daily_assignments. The latter handles "lost signal" cases where
// a rating saved but the highlight_months_reviewed insert never landed.
function normalizeMonthsReviewed(h: any): any[] {
  const fromTable: { id: string; month_year: string; created_at: string | null }[] =
    Array.isArray(h.months_reviewed)
      ? h.months_reviewed.map((mr: any) => ({
          id: mr.id,
          month_year: mr.month_year ?? (typeof mr === 'string' ? mr : null),
          created_at: mr.created_at,
        }))
      : []

  const fromRatings: { id: string; month_year: string; created_at: string | null }[] = []
  if (Array.isArray(h.daily_assignments)) {
    for (const da of h.daily_assignments) {
      const d = da?.daily_summary?.date
      if (!d || da.rating == null) continue
      const monthYear = String(d).split('T')[0].slice(0, 7)
      fromRatings.push({ id: `derived-${monthYear}`, month_year: monthYear, created_at: null })
    }
  }

  // Table entries take precedence (real id/created_at)
  const map = new Map<string, { id: string; month_year: string; created_at: string | null }>()
  for (const mr of fromRatings) if (mr.month_year) map.set(mr.month_year, mr)
  for (const mr of fromTable) if (mr.month_year) map.set(mr.month_year, mr)
  return Array.from(map.values()).sort((a, b) => a.month_year.localeCompare(b.month_year))
}

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
  const months_reviewed = normalizeMonthsReviewed(h)
  const { daily_assignments, embedding, embedding_hash, ...rest } = h
  return { ...rest, assigned_date, months_reviewed }
}

const dailyAssignmentsSelect = 'daily_assignments:daily_summary_highlights(id,rating,daily_summary:daily_summaries(id,date))'
const monthsReviewedSelect = 'months_reviewed:highlight_months_reviewed(id,month_year,created_at)'

const detailSelect = `
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
  ${dailyAssignmentsSelect},
  ${monthsReviewedSelect}
`

function processHighlight(h: any): any {
  return enrichWithAssignedDate({
    ...h,
    categories: h.highlight_categories?.map((hc: any) => hc.category) || [],
    linked_highlights: h.highlight_links_from || [],
  })
}

async function keywordSearch(supabase: any, userId: string, query: string) {
  // Full-text search via ILIKE pattern matching.
  //
  // The term is double-quoted inside the .or() expression (with \ and "
  // escaped) because .or() is a PostgREST filter GRAMMAR: an unquoted
  // comma or parenthesis in the user's query would split the expression —
  // breaking the search with a 500, or injecting extra OR conditions.
  const term = `%${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}%`
  const { data: highlights, error } = await supabase
    .from('highlights')
    .select(detailSelect)
    .eq('user_id', userId)
    .or(`text.ilike."${term}",html_content.ilike."${term}"`)
    .eq('archived', false)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw error
  return (highlights || []).map(processHighlight)
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Defense-in-depth: scope every read to the authenticated user explicitly,
    // in addition to RLS. A request without a valid session is rejected outright.
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { query, type, embedding } = await request.json()

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      )
    }

    const searchType = type || 'fulltext'

    if (searchType !== 'semantic') {
      // The "similar" column populates when the user clicks a result
      // (via /api/search/similar, using stored pgvector embeddings).
      const results = await keywordSearch(supabase, user.id, query)
      return NextResponse.json({ results, similar: [] })
    }

    // Semantic search: the browser embeds the query with gte-small and sends
    // the vector; pgvector's HNSW index finds nearest highlights across the
    // WHOLE library (the old TF-IDF version silently scanned at most 1,000).
    const validEmbedding =
      Array.isArray(embedding) &&
      embedding.length === EMBEDDING_DIM &&
      embedding.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))

    if (!validEmbedding) {
      // Model unavailable in the client (offline, download failed) —
      // degrade to keyword search instead of erroring.
      const results = await keywordSearch(supabase, user.id, query)
      return NextResponse.json({ results, similar: [], fallback: 'keyword' })
    }

    const { data: matches, error: matchError } = await (supabase as any)
      .rpc('match_highlights', {
        query_embedding: `[${embedding.join(',')}]`,
        match_count: SEMANTIC_MATCH_COUNT,
        min_similarity: SEMANTIC_MIN_SIMILARITY,
      })
    if (matchError) throw matchError

    const ranked: { id: string; similarity: number }[] = matches || []
    if (ranked.length === 0) {
      return NextResponse.json({ results: [], similar: [] })
    }

    const { data: details, error: detailError } = await supabase
      .from('highlights')
      .select(detailSelect)
      .in('id', ranked.map((m) => m.id))
      .eq('user_id', user.id)
      .eq('archived', false)
    if (detailError) throw detailError

    const byId = new Map((details || []).map((h: any) => [h.id, h]))
    const ordered = ranked
      .filter((m) => byId.has(m.id))
      .map((m) => processHighlight({ ...(byId.get(m.id) as any), similarity: m.similarity }))

    return NextResponse.json({
      results: ordered.slice(0, SEMANTIC_RESULTS_COUNT),
      similar: ordered.slice(SEMANTIC_RESULTS_COUNT),
    })
  } catch (error: any) {
    console.error('Error performing search:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to perform search' },
      { status: 500 }
    )
  }
}
