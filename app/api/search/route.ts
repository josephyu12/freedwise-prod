import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUserReviewSettings, getCycleForDate } from '@/lib/cycle'

const EMBEDDING_DIM = 384

// Semantic mode is hybrid: pgvector nearest-neighbours fused (reciprocal rank
// fusion) with stemmed Postgres full-text, in one RPC. See
// supabase/migration_hybrid_search.sql for the ranking rules.
//
// Cosine floor for the semantic arm. gte-small clusters tightly on this
// library (median query->highlight similarity ~0.75, real matches 0.85+), and
// the old hard 0.81 cut silently dropped paraphrases that landed at 0.78-0.80.
// This is a noise guard only; ranking does the real work.
const SEMANTIC_MIN_SIMILARITY = 0.75
const SEMANTIC_MATCH_COUNT = 30
// Per-arm candidate pool before fusion.
const HYBRID_CANDIDATE_COUNT = 60

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

// Enrich highlight with the current cycle's assigned_date (for "Review on" tags).
// Cycle-aware: uses the user's frequency to determine the review window.
function enrichWithAssignedDate(h: any, cycleStart: string, cycleEnd: string): any {
  let assigned_date: string | null = null
  if (h.daily_assignments && Array.isArray(h.daily_assignments) && h.daily_assignments.length > 0) {
    const cycleAssignment = h.daily_assignments.find((da: any) => {
      const d = da.daily_summary?.date
      if (!d) return false
      return d >= cycleStart && d <= cycleEnd
    })
    if (cycleAssignment?.daily_summary?.date) {
      assigned_date = cycleAssignment.daily_summary.date
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

function processHighlight(h: any, cycleStart: string, cycleEnd: string): any {
  return enrichWithAssignedDate({
    ...h,
    categories: h.highlight_categories?.map((hc: any) => hc.category) || [],
    linked_highlights: h.highlight_links_from || [],
  }, cycleStart, cycleEnd)
}

// PostgREST reports an RPC that doesn't exist as PGRST202; Postgres itself as
// 42883 (undefined_function).
function isMissingFunction(error: any): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

async function keywordSearch(supabase: any, userId: string, query: string, cycleStart: string, cycleEnd: string) {
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
  return (highlights || []).map((h: any) => processHighlight(h, cycleStart, cycleEnd))
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

    // Resolve the user's review cycle so "Review on" dates match the highlights page.
    const now = new Date()
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    let freq = 1
    try {
      ;({ freq } = await getUserReviewSettings(supabase, user.id))
    } catch (e) {
      // Degrade to monthly window rather than failing the search.
    }
    const cycle = getCycleForDate(todayIso, freq)

    if (searchType !== 'semantic') {
      const results = await keywordSearch(supabase, user.id, query, cycle.startDate, cycle.endDate)
      return NextResponse.json({ results })
    }

    // Semantic search: the browser embeds the query with gte-small and sends
    // the vector. The RPC fuses pgvector nearest-neighbours with stemmed
    // full-text so a remembered turn of phrase is found even when the vector
    // alone ranks it low (and vice versa).
    const validEmbedding =
      Array.isArray(embedding) &&
      embedding.length === EMBEDDING_DIM &&
      embedding.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
    const queryEmbedding = validEmbedding ? `[${embedding.join(',')}]` : null

    let ranked: { id: string; similarity: number | null }[] = []
    let fallback: 'keyword' | undefined

    const { data: matches, error: matchError } = await (supabase as any)
      .rpc('search_highlights_hybrid', {
        query_text: query,
        query_embedding: queryEmbedding,
        match_count: SEMANTIC_MATCH_COUNT,
        candidate_count: HYBRID_CANDIDATE_COUNT,
        min_similarity: SEMANTIC_MIN_SIMILARITY,
      })

    if (!matchError) {
      ranked = matches || []
      // Model unavailable in the client (offline, download failed): the RPC
      // ran its lexical arm alone. Still stemmed + ranked, but tell the UI.
      if (!validEmbedding) fallback = 'keyword'
    } else if (isMissingFunction(matchError)) {
      // migration_hybrid_search.sql not applied yet — degrade to the
      // vector-only RPC (or ILIKE without a vector) rather than failing.
      console.warn('search_highlights_hybrid missing; falling back to match_highlights')
      if (!validEmbedding) {
        const results = await keywordSearch(supabase, user.id, query, cycle.startDate, cycle.endDate)
        return NextResponse.json({ results, fallback: 'keyword' })
      }
      const { data: legacy, error: legacyError } = await (supabase as any)
        .rpc('match_highlights', {
          query_embedding: queryEmbedding,
          match_count: SEMANTIC_MATCH_COUNT,
          min_similarity: SEMANTIC_MIN_SIMILARITY,
        })
      if (legacyError) throw legacyError
      ranked = legacy || []
    } else {
      throw matchError
    }

    if (ranked.length === 0) {
      return NextResponse.json({ results: [], ...(fallback ? { fallback } : {}) })
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
      .map((m) => processHighlight({ ...(byId.get(m.id) as any), similarity: m.similarity }, cycle.startDate, cycle.endDate))

    return NextResponse.json({ results: ordered, ...(fallback ? { fallback } : {}) })
  } catch (error: any) {
    console.error('Error performing search:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to perform search' },
      { status: 500 }
    )
  }
}
