import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Extract plain text from HTML by stripping tags
function htmlToPlainText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, '') // Strip HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Get authenticated user
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized - must be authenticated' },
        { status: 401 }
      )
    }

    console.log('[migrate-text-fields] Starting migration for user:', user.id)

    // Get all highlights with html_content
    const { data: highlights, error: fetchError } = await supabase
      .from('highlights')
      .select('id, html_content')
      .eq('user_id', user.id)
      .not('html_content', 'is', null)

    if (fetchError) throw fetchError

    if (!highlights || highlights.length === 0) {
      return NextResponse.json({
        message: 'No highlights to migrate',
        updated: 0,
      })
    }

    console.log('[migrate-text-fields] Found', highlights.length, 'highlights to update')

    // Type the highlights array
    const typedHighlights = highlights as Array<{ id: string; html_content: string }>

    let updated = 0
    for (const highlight of typedHighlights) {
      const newText = htmlToPlainText(highlight.html_content)

      const { error: updateError } = await supabase
        .from('highlights')
        .update({ text: newText })
        .eq('id', highlight.id)
        .eq('user_id', user.id)

      if (updateError) {
        console.error('[migrate-text-fields] Failed to update highlight', highlight.id, updateError)
      } else {
        updated++
      }
    }

    console.log('[migrate-text-fields] Migration complete. Updated', updated, 'highlights')

    return NextResponse.json({
      message: 'Migration completed successfully',
      total: highlights.length,
      updated: updated,
    })
  } catch (error: any) {
    console.error('[migrate-text-fields] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to migrate text fields' },
      { status: 500 }
    )
  }
}
