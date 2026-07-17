import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const EMBEDDING_DIM = 384
const MAX_ITEMS = 200

// Write back embeddings computed client-side. Each item carries the exact
// text that was embedded; the set_highlight_embeddings RPC stores
// md5(that text) as embedding_hash, so an edit racing this request leaves
// the row stale and it is re-embedded on the next sync pass. The RPC is
// SECURITY INVOKER and filters on auth.uid(), so cross-user writes are
// impossible even with forged ids.
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { items } = await request.json()

    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return NextResponse.json(
        { error: `items must be a non-empty array of at most ${MAX_ITEMS}` },
        { status: 400 }
      )
    }

    for (const item of items) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        typeof item.text !== 'string' ||
        !Array.isArray(item.embedding) ||
        item.embedding.length !== EMBEDDING_DIM ||
        item.embedding.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))
      ) {
        return NextResponse.json(
          { error: `Each item needs id, text, and a ${EMBEDDING_DIM}-dim numeric embedding` },
          { status: 400 }
        )
      }
    }

    const { data: updated, error } = await (supabase as any)
      .rpc('set_highlight_embeddings', {
        p_items: items.map((i: any) => ({
          id: i.id,
          text: i.text,
          embedding: i.embedding,
        })),
      })
    if (error) throw error

    return NextResponse.json({ updated: Number(updated) || 0 })
  } catch (error: any) {
    console.error('Error updating embeddings:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to update embeddings' },
      { status: 500 }
    )
  }
}
