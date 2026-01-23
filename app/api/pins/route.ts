import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// GET: Get all pinned highlights for the user
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: pinnedHighlights, error } = await (supabase
      .from('pinned_highlights') as any)
      .select(`
        id,
        highlight_id,
        pinned_at,
        highlights (
          id,
          text,
          html_content,
          created_at
        )
      `)
      .eq('user_id', user.id)
      .order('pinned_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ pinnedHighlights: pinnedHighlights || [] })
  } catch (error: any) {
    console.error('Error fetching pinned highlights:', error)
    return NextResponse.json({ error: error.message || 'Failed to fetch pinned highlights' }, { status: 500 })
  }
}

// POST: Pin a highlight
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { highlightId } = await request.json()

    if (!highlightId) {
      return NextResponse.json({ error: 'highlightId is required' }, { status: 400 })
    }

    // Check if already pinned
    const { data: existingPin } = await (supabase
      .from('pinned_highlights') as any)
      .select('id')
      .eq('user_id', user.id)
      .eq('highlight_id', highlightId)
      .single()

    if (existingPin) {
      return NextResponse.json({ error: 'Highlight is already pinned' }, { status: 400 })
    }

    // Check current pin count
    const { count, error: countError } = await supabase
      .from('pinned_highlights')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)

    if (countError) throw countError

    if (count && count >= 10) {
      return NextResponse.json({ 
        error: 'Maximum of 10 pinned highlights reached',
        isFull: true 
      }, { status: 400 })
    }

    // Pin the highlight
    const { data, error } = await (supabase
      .from('pinned_highlights') as any)
      .insert({
        user_id: user.id,
        highlight_id: highlightId,
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ pinnedHighlight: data })
  } catch (error: any) {
    console.error('Error pinning highlight:', error)
    return NextResponse.json({ error: error.message || 'Failed to pin highlight' }, { status: 500 })
  }
}

// DELETE: Unpin a highlight
export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const highlightId = searchParams.get('highlightId')

    if (!highlightId) {
      return NextResponse.json({ error: 'highlightId is required' }, { status: 400 })
    }

    const { error } = await (supabase
      .from('pinned_highlights') as any)
      .delete()
      .eq('user_id', user.id)
      .eq('highlight_id', highlightId)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Error unpinning highlight:', error)
    return NextResponse.json({ error: error.message || 'Failed to unpin highlight' }, { status: 500 })
  }
}

