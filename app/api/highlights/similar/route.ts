import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// gte-small; kept local like the other server routes so this bundle never
// touches lib/clientEmbeddings (which pulls in transformers.js).
const EMBEDDING_DIM = 384

// Cosine floor for "you may already have this". Deliberately a notch above
// the /merge page's loosest tier (0.85): this fires while the user is still
// typing, so a false alarm costs attention every time. On the real library,
// pairs at ~0.87+ read as the same point being made.
const MIN_SIMILARITY = 0.87
const MATCH_COUNT = 3

export type SimilarSavedHighlight = {
  id: string
  text: string
  html_content: string | null
  source: string | null
  author: string | null
  similarity: number
}

// POST /api/highlights/similar  { embedding: number[384] }
// Nearest saved (active) highlights to a draft the browser has already
// embedded with gte-small. Powers the write-time duplicate nudge.
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const embedding = body?.embedding
    const valid =
      Array.isArray(embedding) &&
      embedding.length === EMBEDDING_DIM &&
      embedding.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
    if (!valid) {
      return NextResponse.json({ error: 'embedding must be a 384-float array' }, { status: 400 })
    }

    const { data: matches, error: matchError } = await (supabase as any).rpc('match_highlights', {
      query_embedding: `[${embedding.join(',')}]`,
      match_count: MATCH_COUNT,
      min_similarity: MIN_SIMILARITY,
    })
    if (matchError) throw matchError

    const ranked = (matches || []) as { id: string; similarity: number }[]
    if (ranked.length === 0) return NextResponse.json({ similar: [] })

    const { data: rows, error: rowsError } = await supabase
      .from('highlights')
      .select('id, text, html_content, source, author')
      .in('id', ranked.map((m) => m.id))
      .eq('user_id', user.id)
    if (rowsError) throw rowsError

    const byId = new Map(((rows || []) as any[]).map((h) => [h.id, h]))
    const similar: SimilarSavedHighlight[] = ranked
      .map((m) => {
        const h = byId.get(m.id)
        if (!h) return null
        return {
          id: h.id,
          text: h.text,
          html_content: h.html_content ?? null,
          source: h.source ?? null,
          author: h.author ?? null,
          similarity: Number(m.similarity),
        }
      })
      .filter((x): x is SimilarSavedHighlight => x !== null)

    return NextResponse.json({ similar })
  } catch (error: any) {
    console.error('Error finding similar highlights:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to find similar highlights' },
      { status: 500 }
    )
  }
}
