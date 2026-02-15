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

    // Get ALL highlights with html_content (paginate to avoid limit)
    const allHighlights: Array<{ id: string; text: string | null; html_content: string }> = []
    let fetchCursor = 0
    const pageSize = 1000

    while (true) {
      const { data: batch, error: fetchError } = await supabase
        .from('highlights')
        .select('id, text, html_content')
        .eq('user_id', user.id)
        .not('html_content', 'is', null)
        .range(fetchCursor, fetchCursor + pageSize - 1)

      if (fetchError) throw fetchError

      if (!batch || batch.length === 0) break

      allHighlights.push(...(batch as Array<{ id: string; text: string | null; html_content: string }>))

      console.log('[migrate-text-fields] Fetched batch:', batch.length, 'total so far:', allHighlights.length)

      // If we got fewer than pageSize, we've reached the end
      if (batch.length < pageSize) break

      fetchCursor += pageSize
    }

    if (allHighlights.length === 0) {
      return NextResponse.json({
        message: 'No highlights to migrate',
        updated: 0,
      })
    }

    console.log('[migrate-text-fields] Found', allHighlights.length, 'highlights total')

    let updated = 0
    let skipped = 0
    for (const highlight of allHighlights) {
      const newText = htmlToPlainText(highlight.html_content)
      const currentText = (highlight.text || '').trim()

      // Skip if text is already correct
      if (currentText === newText) {
        skipped++
        continue
      }

      const { error: updateError } = await (supabase
        .from('highlights') as any)
        .update({ text: newText })
        .eq('id', highlight.id)
        .eq('user_id', user.id)

      if (updateError) {
        console.error('[migrate-text-fields] Failed to update highlight', highlight.id, updateError)
      } else {
        updated++
        if (updated % 100 === 0) {
          console.log('[migrate-text-fields] Progress:', updated, 'updated,', skipped, 'skipped')
        }
      }
    }

    console.log('[migrate-text-fields] Migration complete. Updated:', updated, 'Skipped:', skipped, 'Total:', allHighlights.length)

    return NextResponse.json({
      message: 'Migration completed successfully',
      total: allHighlights.length,
      updated: updated,
      skipped: skipped,
    })
  } catch (error: any) {
    console.error('[migrate-text-fields] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to migrate text fields' },
      { status: 500 }
    )
  }
}
