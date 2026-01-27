import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/notion/queue
 * Add an item to the Notion sync queue with deduplication.
 * Skips insert if there is already a pending or processing item for the same
 * (user_id, highlight_id, operation_type) for add/update operations.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const {
      highlightId,
      operationType,
      text = null,
      htmlContent = null,
      originalText = null,
      originalHtmlContent = null,
    } = body as {
      highlightId: string | null
      operationType: 'add' | 'update' | 'delete'
      text?: string | null
      htmlContent?: string | null
      originalText?: string | null
      originalHtmlContent?: string | null
    }

    if (!operationType || !['add', 'update', 'delete'].includes(operationType)) {
      return NextResponse.json({ error: 'Invalid operationType' }, { status: 400 })
    }

    const { data: notionSettings, error: settingsError } = await supabase
      .from('user_notion_settings')
      .select('notion_api_key, notion_page_id, enabled')
      .eq('user_id', user.id)
      .eq('enabled', true)
      .maybeSingle()

    if (settingsError || !notionSettings) {
      return NextResponse.json({ enqueued: false, message: 'Notion integration not configured' })
    }

    // Deduplicate: skip if there is already a pending/processing item for this highlight + operation
    // (For delete, highlightId is typically the id before delete; we still dedupe by highlight_id when provided)
    if (operationType !== 'delete' && highlightId) {
      const { data: existing } = await (supabase
        .from('notion_sync_queue') as any)
        .select('id')
        .eq('user_id', user.id)
        .eq('highlight_id', highlightId)
        .eq('operation_type', operationType)
        .in('status', ['pending', 'processing'])
        .limit(1)
        .maybeSingle()

      if (existing) {
        return NextResponse.json({ enqueued: false, message: 'Already in queue', existing: true })
      }
    }

    const queueItem: Record<string, unknown> = {
      user_id: user.id,
      highlight_id: operationType === 'delete' ? null : highlightId,
      operation_type: operationType,
      text: text ?? null,
      html_content: htmlContent ?? null,
      status: 'pending',
      retry_count: 0,
      max_retries: 5,
      ...(operationType === 'update' && (originalText || originalHtmlContent)
        ? { original_text: originalText ?? null, original_html_content: originalHtmlContent ?? null }
        : {}),
    }

    const { error: insertError } = await (supabase
      .from('notion_sync_queue') as any)
      .insert([queueItem])

    if (insertError) {
      console.warn('Failed to add to sync queue:', insertError)
      return NextResponse.json({ enqueued: false, error: insertError.message }, { status: 500 })
    }

    return NextResponse.json({ enqueued: true })
  } catch (error: any) {
    console.error('Error enqueueing Notion sync:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to enqueue' },
      { status: 500 }
    )
  }
}
