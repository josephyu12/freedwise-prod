import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Rows that still need (re-)embedding: never embedded, or text edited since
// the stored embedding_hash was computed. The client embeds these in the
// browser and posts vectors back to /api/embeddings/update.
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: pending, error: pendingError } = await (supabase as any)
      .rpc('embedding_pending', { batch_count: 100 })
    if (pendingError) throw pendingError

    const { data: remaining, error: countError } = await (supabase as any)
      .rpc('embedding_pending_count')
    if (countError) throw countError

    return NextResponse.json({
      pending: pending || [],
      remaining: Number(remaining) || 0,
    })
  } catch (error: any) {
    console.error('Error fetching pending embeddings:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch pending embeddings' },
      { status: 500 }
    )
  }
}
