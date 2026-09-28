import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// Cosine floor for "these two highlights are about the same thing".
// Measured on the real library: the median highlight's nearest neighbour sits
// at ~0.87 and 88% of highlights have at least one neighbour >= 0.85, while
// pairs below ~0.84 read as merely adjacent topics. Explicit links bypass it.
const RELATED_MIN_SIMILARITY = 0.85
const RELATED_COUNT = 5

export type RelatedHighlight = {
  id: string
  text: string
  source: string | null
  author: string | null
  // null when the pair is linked explicitly but not similar enough to surface
  similarity: number | null
  linked: boolean
}

// GET /api/highlights/:id/related
// Union of (a) highlights explicitly linked to :id and (b) the nearest
// neighbours by embedding via the `similar_highlights` RPC. Linked first,
// then by similarity.
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [{ data: similar, error: simError }, { data: linkRows, error: linkError }] =
      await Promise.all([
        (supabase as any).rpc('similar_highlights', {
          p_highlight_id: id,
          match_count: RELATED_COUNT,
          min_similarity: RELATED_MIN_SIMILARITY,
        }),
        (supabase.from('highlight_links') as any)
          .select('from_highlight_id, to_highlight_id')
          .or(`from_highlight_id.eq.${id},to_highlight_id.eq.${id}`),
      ])
    if (simError) throw simError
    if (linkError) throw linkError

    const linkedIds = new Set<string>()
    for (const r of (linkRows || []) as { from_highlight_id: string; to_highlight_id: string }[]) {
      linkedIds.add(r.from_highlight_id === id ? r.to_highlight_id : r.from_highlight_id)
    }
    const simById = new Map<string, number>(
      ((similar || []) as { id: string; similarity: number }[]).map((m) => [m.id, m.similarity])
    )

    const ids = Array.from(new Set([...linkedIds, ...simById.keys()])).filter((x) => x !== id)
    if (ids.length === 0) return NextResponse.json({ related: [] })

    const { data: rows, error: rowsError } = await supabase
      .from('highlights')
      .select('id, text, source, author, archived')
      .in('id', ids)
      .eq('user_id', user.id)
    if (rowsError) throw rowsError

    const related: RelatedHighlight[] = ((rows || []) as any[])
      // Linked-but-archived highlights stay visible (the link is deliberate);
      // archived similarity hits are already excluded by the RPC.
      .map((h) => ({
        id: h.id,
        text: h.text,
        source: h.source ?? null,
        author: h.author ?? null,
        similarity: simById.get(h.id) ?? null,
        linked: linkedIds.has(h.id),
      }))
      .sort((a, b) => {
        if (a.linked !== b.linked) return a.linked ? -1 : 1
        return (b.similarity ?? 0) - (a.similarity ?? 0)
      })

    return NextResponse.json({ related })
  } catch (error: any) {
    console.error('Error loading related highlights:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to load related highlights' },
      { status: 500 }
    )
  }
}
