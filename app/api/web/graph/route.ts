import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildEdges, parseEmbedding, GraphNodeInput } from '@/lib/graphEdges'

// Edge computation over the whole library is O(n²) on ~1,600 nodes;
// give the function headroom beyond the 10s default.
export const maxDuration = 60

const PAGE_SIZE = 1000

// Per-lambda cache: the graph only changes when highlights or embeddings do,
// and a 5-minute-stale web is fine for a reflection tool.
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; payload: any }>()

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Defense-in-depth: scope every read to the authenticated user explicitly,
    // in addition to RLS. A request without a valid session is rejected outright.
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const refresh = request.nextUrl.searchParams.get('refresh') === '1'
    const cached = cache.get(user.id)
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return NextResponse.json(cached.payload)
    }

    // Page through the WHOLE library — PostgREST caps single responses at
    // 1,000 rows, which is exactly the silent truncation that broke the old
    // semantic search. Ordered paging makes the pages stable.
    const rows: any[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('highlights')
        .select(`
          id,
          text,
          source,
          author,
          embedding,
          highlight_categories (
            category:categories (id, name, color)
          )
        `)
        .eq('user_id', user.id)
        .eq('archived', false)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < PAGE_SIZE) break
    }

    const categoriesById = new Map<string, { id: string; name: string; color: string | null }>()
    const nodeInputs: GraphNodeInput[] = []
    const texts: string[] = []
    const nodes = rows.map((h: any, index: number) => {
      const cats = (h.highlight_categories || [])
        .map((hc: any) => hc.category)
        .filter(Boolean)
      for (const c of cats) categoriesById.set(c.id, c)
      const embedding = parseEmbedding(h.embedding)
      nodeInputs.push({ index, text: h.text, embedding })
      texts.push(h.text)
      return {
        id: h.id,
        text: h.text,
        source: h.source || null,
        author: h.author || null,
        cats: cats.map((c: any) => c.id),
        hasEmbedding: embedding !== null,
      }
    })

    const edges = buildEdges(nodeInputs, texts)

    const embedded = nodeInputs.filter((n) => n.embedding !== null).length
    const payload = {
      nodes,
      edges,
      categories: Array.from(categoriesById.values()),
      stats: {
        highlights: nodes.length,
        embedded,
        edges: edges.length,
      },
    }

    cache.set(user.id, { at: Date.now(), payload })
    return NextResponse.json(payload)
  } catch (error: any) {
    console.error('Error building highlight graph:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to build highlight graph' },
      { status: 500 }
    )
  }
}
