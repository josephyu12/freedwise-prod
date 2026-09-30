import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tokenize } from '@/lib/graphEdges'

export const dynamic = 'force-dynamic'
// One HNSW probe per highlight; give the whole-library pass headroom.
export const maxDuration = 60

// Lowest cosine the API will return. The page filters further client-side
// (85 / 90 / 95%) so switching thresholds is instant. Measured on the real
// library, pairs below ~0.84 read as merely adjacent topics.
const MIN_SIMILARITY = 0.85
// Per-highlight neighbour cap inside the RPC (not a global cap).
const PER_HIGHLIGHT = 5

export type MergeCandidate = {
  id: string
  text: string
  html_content: string | null
  source: string | null
  author: string | null
  created_at: string
  average_rating: number
  rating_count: number
  resurface_count: number
  categories: { id: string; name: string; color: string | null }[]
}

export type MergeSuggestion = {
  a: MergeCandidate
  b: MergeCandidate
  // cosine similarity of the two embeddings, 0..1
  similarity: number
  // share of distinctive words the two texts have in common (Jaccard), 0..1.
  // A second, more literal signal next to the embedding: high overlap means
  // "same sentence reworded", low overlap means "same idea, different words".
  wordOverlap: number
}

function isMissingFunction(error: any): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

function jaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a))
  const sb = new Set(tokenize(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}

// GET /api/highlights/merge-suggestions
// Pairs of the caller's active highlights that say (nearly) the same thing,
// strongest first, with both highlights inlined so the page can render each
// pair without a second round trip.
export async function GET(_request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: pairs, error: pairsError } = await (supabase as any).rpc('near_duplicate_pairs', {
      min_similarity: MIN_SIMILARITY,
      per_highlight: PER_HIGHLIGHT,
    })
    if (pairsError) {
      if (isMissingFunction(pairsError)) {
        return NextResponse.json(
          {
            error: 'migration_required',
            message:
              'Run supabase/migration_merge_suggestions.sql in the Supabase SQL editor to enable merge suggestions.',
          },
          { status: 501 }
        )
      }
      throw pairsError
    }

    const rawPairs = (pairs || []) as { a_id: string; b_id: string; similarity: number }[]
    if (rawPairs.length === 0) return NextResponse.json({ suggestions: [] })

    const ids = Array.from(new Set(rawPairs.flatMap((p) => [p.a_id, p.b_id])))
    const { data: rows, error: rowsError } = await supabase
      .from('highlights')
      .select(`
        id, text, html_content, source, author, created_at,
        average_rating, rating_count, resurface_count,
        highlight_categories ( category:categories (id, name, color) )
      `)
      .in('id', ids)
      .eq('user_id', user.id)
    if (rowsError) throw rowsError

    const byId = new Map<string, MergeCandidate>()
    for (const h of (rows || []) as any[]) {
      byId.set(h.id, {
        id: h.id,
        text: h.text,
        html_content: h.html_content ?? null,
        source: h.source ?? null,
        author: h.author ?? null,
        created_at: h.created_at,
        average_rating: Number(h.average_rating) || 0,
        rating_count: Number(h.rating_count) || 0,
        resurface_count: Number(h.resurface_count) || 0,
        categories: (h.highlight_categories || [])
          .map((hc: any) => hc.category)
          .filter(Boolean),
      })
    }

    const suggestions: MergeSuggestion[] = []
    for (const p of rawPairs) {
      const a = byId.get(p.a_id)
      const b = byId.get(p.b_id)
      if (!a || !b) continue
      suggestions.push({
        a,
        b,
        similarity: Number(p.similarity),
        wordOverlap: jaccard(a.text, b.text),
      })
    }

    return NextResponse.json({ suggestions })
  } catch (error: any) {
    console.error('Error loading merge suggestions:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to load merge suggestions' },
      { status: 500 }
    )
  }
}
