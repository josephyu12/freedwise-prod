import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Client } from '@notionhq/client'
import { htmlToNotionBlocks, htmlToBlockText, normalizeForBlockCompare, getBlockText, findMatchingHighlightBlocks, buildNormalizedSearchStrings, flattenBlocksWithChildren, BLOCK_BOUNDARY, buildNormalizedBlockGroups, appendBlocksDeep } from '@/lib/notionBlocks'

// Process a single queue item. Claim with status=processing first to avoid duplicate processing when multiple sync requests run.
async function processQueueItem(supabase: any, queueItem: any, notionSettings: { notion_api_key: string; notion_page_id: string; enabled: boolean }) {
  // Claim this item so concurrent sync requests don't process it twice (fixes multiple items / bullet quadrupling)
  const { data: claimed } = await (supabase
    .from('notion_sync_queue') as any)
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', queueItem.id)
    .in('status', ['pending', 'failed'])
    .select('id')
  if (!claimed || claimed.length === 0) {
    return { success: true }
  }

  const notion = new Client({
    auth: notionSettings.notion_api_key,
  })

  try {
    if (queueItem.operation_type === 'add') {
      const blocks = htmlToNotionBlocks(queueItem.html_content || queueItem.text)
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: [] },
      })

      await appendBlocksDeep(notion, notionSettings.notion_page_id, blocks)
    } else if (queueItem.operation_type === 'update') {
      // For update, use the ORIGINAL text stored in the queue item to find the block.
      // Convert original_html_content to block-order text (same format as Notion: parts joined by space)
      // so paragraph + list highlights match.
      let originalBlockText = ''
      let originalPlainText = (queueItem.original_text || '').trim().toLowerCase()
      if (queueItem.original_html_content) {
        originalBlockText = htmlToBlockText(queueItem.original_html_content).trim().toLowerCase()
      }
      if (!originalBlockText && originalPlainText) {
        originalBlockText = originalPlainText
      }
      if (!originalBlockText && !originalPlainText && queueItem.highlight_id) {
        const { data: currentHighlight } = await (supabase
          .from('highlights') as any)
          .select('text, html_content')
          .eq('id', queueItem.highlight_id)
          .maybeSingle()
        if (currentHighlight) {
          const fallbackHtml = (currentHighlight.html_content || '').trim()
          const fallbackPlain = (currentHighlight.text || '').trim().toLowerCase()
          if (fallbackHtml || fallbackPlain) {
            originalBlockText = fallbackHtml ? htmlToBlockText(fallbackHtml).trim().toLowerCase() : fallbackPlain
            originalPlainText = fallbackPlain || originalPlainText
          }
        }
      }

      const { normalizedOriginalNoHtml, normalizedOriginalPlainNoHtml } = buildNormalizedSearchStrings(originalBlockText, originalPlainText)

      const debugPayload = {
        searchFromBlockOrder: normalizedOriginalNoHtml || null,
        searchFromPlainText: normalizedOriginalPlainNoHtml !== normalizedOriginalNoHtml ? normalizedOriginalPlainNoHtml : undefined,
        sampleNotionBlockGroups: [] as string[],
      }

      // Use DB as source of truth for new content (DB → Notion). Prefer current highlight row so nested bullets etc. are included even if queue payload was stale.
      let newContentHtml = queueItem.html_content ?? null
      let newContentText = queueItem.text ?? null
      if (queueItem.highlight_id) {
        const { data: currentHighlight } = await (supabase
          .from('highlights') as any)
          .select('text, html_content')
          .eq('id', queueItem.highlight_id)
          .maybeSingle()
        if (currentHighlight?.text != null || currentHighlight?.html_content != null) {
          newContentText = currentHighlight.text ?? newContentText
          newContentHtml = currentHighlight.html_content ?? newContentHtml
        }
      }
      // Fetch all blocks from Notion page (top-level only first)
      let allBlocks: any[] = []
      let cursor = undefined
      do {
        const response = await notion.blocks.children.list({
          block_id: notionSettings.notion_page_id,
          start_cursor: cursor,
        })
        allBlocks.push(...response.results)
        cursor = response.next_cursor || undefined
      } while (cursor)

      // Save top-level blocks before flattening (needed for position tracking during delete-and-recreate)
      const topLevelBlocks = [...allBlocks]

      // Include nested/indented children so sub-bullets are in the list and can match
      allBlocks = await flattenBlocksWithChildren(notion, allBlocks)

      const { matchingBlocks, foundMatch, exactMatch } = findMatchingHighlightBlocks(
        allBlocks,
        normalizedOriginalNoHtml,
        normalizedOriginalPlainNoHtml,
        originalBlockText // BLOCK_BOUNDARY-separated text for per-block matching
      )

      if (!foundMatch || matchingBlocks.length === 0) {
        debugPayload.sampleNotionBlockGroups = buildNormalizedBlockGroups(allBlocks).slice(-8)
        console.warn('[notion/sync] update: Highlight not found. Full debug (last 8 block groups):', JSON.stringify(debugPayload, null, 2))
        throw new Error('Highlight not found in Notion page. It may have been deleted or moved.')
      }

      if (foundMatch && matchingBlocks.length > 0) {
        debugPayload.sampleNotionBlockGroups = [normalizeForBlockCompare(matchingBlocks.map(getBlockText).join(BLOCK_BOUNDARY))]
      }

      // Re-fetch highlight from DB right before pushing so we have the latest saved content (e.g. new nested bullet)
      if (queueItem.highlight_id) {
        const { data: latestHighlight } = await (supabase
          .from('highlights') as any)
          .select('text, html_content')
          .eq('id', queueItem.highlight_id)
          .maybeSingle()
        if (latestHighlight?.text != null || latestHighlight?.html_content != null) {
          newContentText = latestHighlight.text ?? newContentText
          newContentHtml = latestHighlight.html_content ?? newContentHtml
        }
      }

      // Build hierarchical new blocks (NOT flattened — preserves nested bullet structure)
      const newBlocks = htmlToNotionBlocks(newContentHtml || newContentText || '')

      ;(debugPayload as any).newBlocksLength = newBlocks.length
      ;(debugPayload as any).matchingBlocksLength = matchingBlocks.length
      ;(debugPayload as any).usedHtml = !!(newContentHtml && newContentHtml.trim())
      ;(debugPayload as any).exactMatch = exactMatch
      console.warn('[notion/sync] update: Highlight found. Full debug:', JSON.stringify(debugPayload, null, 2))

      // Delete-and-recreate: delete all matching top-level blocks (children cascade),
      // then insert new hierarchical blocks at the same position. This correctly handles
      // nested bullets, added/removed blocks, and type changes without index misalignment.
      const matchingIds = new Set(matchingBlocks.map((b: any) => b.id))
      const topLevelMatchingBlocks = topLevelBlocks.filter((b: any) => matchingIds.has(b.id))

      // Find the block before the match group for insertion position
      const firstTopLevelMatchIndex = topLevelBlocks.findIndex((b: any) => matchingIds.has(b.id))
      const afterBlockId = firstTopLevelMatchIndex > 0 ? topLevelBlocks[firstTopLevelMatchIndex - 1].id : null

      // Delete top-level matching blocks (Notion cascades to children automatically)
      for (const block of topLevelMatchingBlocks) {
        try {
          await notion.blocks.delete({ block_id: block.id })
        } catch (error: any) {
          console.error(`Failed to delete block ${block.id} (${block.type}):`, error.message || error)
          throw error
        }
      }

      // Insert new hierarchical blocks at the correct position
      await appendBlocksDeep(notion, notionSettings.notion_page_id, newBlocks, afterBlockId)
    } else if (queueItem.operation_type === 'delete') {
      // For delete, use the text/html_content stored in the queue item to find the block
      // Fetch all blocks from Notion page
      const allBlocks: any[] = []
      let cursor = undefined
      
      do {
        const response = await notion.blocks.children.list({
          block_id: notionSettings.notion_page_id,
          start_cursor: cursor,
        })
        allBlocks.push(...response.results)
        cursor = response.next_cursor || undefined
      } while (cursor)

      // Use shared htmlToBlockText so delete search text matches Notion block order (paragraph + list).
      // Function to extract plain text from a block
      const getBlockText = (block: any): string => {
        // Handle different block types
        if (block.type === 'bulleted_list_item' && block.bulleted_list_item?.rich_text) {
          return block.bulleted_list_item.rich_text
            .map((t: any) => t.plain_text || '')
            .join('')
            .trim()
            .toLowerCase()
        }
        if (block.type === 'numbered_list_item' && block.numbered_list_item?.rich_text) {
          return block.numbered_list_item.rich_text
            .map((t: any) => t.plain_text || '')
            .join('')
            .trim()
            .toLowerCase()
        }
        if (block[block.type]?.rich_text) {
          return block[block.type].rich_text
            .map((t: any) => t.plain_text || '')
            .join('')
            .trim()
            .toLowerCase()
        }
        return ''
      }
      
      // Function to normalize text for comparison (remove extra whitespace, normalize quotes, etc.)
      const normalizeText = (text: string): string => {
        return text
          .replace(/\s+/g, ' ') // Normalize whitespace
          .replace(/[""]/g, '"') // Normalize quotes
          .replace(/['']/g, "'") // Normalize apostrophes
          .trim()
          .toLowerCase()
      }

      // Strip HTML for comparison: replace tags with space so list items don't get glued together
      const stripHtmlForCompare = (text: string): string => {
        return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
      }
      
      // Convert HTML content to block text format (same as what we extract from Notion)
      const deleteTextFromHtml = queueItem.html_content ? htmlToBlockText(queueItem.html_content) : ''
      const deleteTextFromPlain = queueItem.text || ''
      
      // Normalize the delete text for comparison
      const normalizedDeleteText = normalizeText(deleteTextFromHtml || deleteTextFromPlain)
      const normalizedDeletePlainText = normalizeText(deleteTextFromPlain)

      if (!normalizedDeleteText && !normalizedDeletePlainText) {
        throw new Error('Cannot delete highlight: no text content available to find in Notion')
      }

      // Find matching blocks (blocks that contain the text to delete)
      // Group blocks by empty line separators OR by block type transitions
      // List items (bulleted/numbered) should be grouped together
      const matchingBlocks: any[] = []
      let currentHighlightBlocks: any[] = []
      let foundMatch = false
      let emptyLineBefore: any | null = null
      let emptyLineAfter: any | null = null

      // Helper to check if a block is an empty paragraph
      const isEmptyParagraph = (block: any) =>
        block.type === 'paragraph' &&
        (!block.paragraph?.rich_text || block.paragraph.rich_text.length === 0)

      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i]
        const isEmpty = isEmptyParagraph(block)

        // Only split groups on empty paragraphs (the separator between highlights)
        if (isEmpty && currentHighlightBlocks.length > 0) {
          // Check if this group of blocks matches the highlight to delete
          const combinedText = normalizeText(
            currentHighlightBlocks
              .map(getBlockText)
              .join(' ')
          )

          // Match using normalized text (strip HTML, replace tags with space so list items compare correctly)
          const normalizedCombined = stripHtmlForCompare(combinedText)
          const normalizedDeleteNoHtml = stripHtmlForCompare(normalizedDeleteText)
          const normalizedDeletePlainNoHtml = stripHtmlForCompare(normalizedDeletePlainText)

          // Exact match only: group text must equal the highlight we're deleting
          if (normalizedCombined === normalizedDeleteNoHtml || normalizedCombined === normalizedDeletePlainNoHtml) {
            matchingBlocks.push(...currentHighlightBlocks)
            // The empty line after is the current block (if it's empty)
            if (isEmpty) {
            emptyLineAfter = block
            }
            foundMatch = true
            break
          }

          // Reset for next group - the empty line before the next group is this one (if it's empty)
          if (isEmpty) {
          emptyLineBefore = block
          }
          currentHighlightBlocks = []
          
          // If this was an empty paragraph, skip it and continue
          if (isEmpty) {
          continue
          }
        }

        // Add block to current group (unless it's an empty paragraph at the start)
        if (!isEmpty) {
          // Before extending the group, check if the current group alone already matches
          // (fixes delete for single-block highlights when followed by another block with no empty line)
          if (currentHighlightBlocks.length > 0) {
            const currentCombined = normalizeText(
              currentHighlightBlocks.map(getBlockText).join(' ')
            )
            const normalizedCurrent = stripHtmlForCompare(currentCombined)
            const normalizedDeleteNoHtml = stripHtmlForCompare(normalizedDeleteText)
            const normalizedDeletePlainNoHtml = stripHtmlForCompare(normalizedDeletePlainText)
            // Exact match only: current group text must equal the highlight we're deleting
            if (normalizedCurrent === normalizedDeleteNoHtml || normalizedCurrent === normalizedDeletePlainNoHtml) {
              matchingBlocks.push(...currentHighlightBlocks)
              foundMatch = true
              break
            }
          }
          currentHighlightBlocks.push(block)
          // Clear emptyLineBefore since we're in a group now
          emptyLineBefore = null
        } else if (isEmpty && currentHighlightBlocks.length === 0) {
          // Empty line before the current group starts
          emptyLineBefore = block
        }
      }

      // Check the last group if we haven't found a match
      if (!foundMatch && currentHighlightBlocks.length > 0) {
        const combinedText = normalizeText(
          currentHighlightBlocks
            .map(getBlockText)
            .join(' ')
        )

        // Match using normalized text (strip HTML, replace tags with space so list items compare correctly)
        const normalizedCombined = stripHtmlForCompare(combinedText)
        const normalizedDeleteNoHtml = stripHtmlForCompare(normalizedDeleteText)
        const normalizedDeletePlainNoHtml = stripHtmlForCompare(normalizedDeletePlainText)

        // Exact match only: group text must equal the highlight we're deleting
        if (normalizedCombined === normalizedDeleteNoHtml || normalizedCombined === normalizedDeletePlainNoHtml) {
          matchingBlocks.push(...currentHighlightBlocks)
          foundMatch = true
        }
      }

      if (!foundMatch || matchingBlocks.length === 0) {
        throw new Error('Highlight not found in Notion page. It may have already been deleted.')
      }

      // Delete all matching blocks; fail the queue item if any delete fails
      for (const block of matchingBlocks) {
        await notion.blocks.delete({ block_id: block.id })
      }

      // Delete the empty line separator (prefer the one after, but use before if after doesn't exist)
      const emptyLineToDelete = emptyLineAfter || emptyLineBefore
      if (emptyLineToDelete && emptyLineToDelete.type === 'paragraph' && 
          (!emptyLineToDelete.paragraph?.rich_text || emptyLineToDelete.paragraph.rich_text.length === 0)) {
        await notion.blocks.delete({ block_id: emptyLineToDelete.id })
      }
    }

    // Mark as completed
    await (supabase
      .from('notion_sync_queue') as any)
      .update({
        status: 'completed',
        processed_at: new Date().toISOString(),
      })
      .eq('id', queueItem.id)

    return { success: true }
  } catch (error: any) {
    // Mark as failed and increment retry count
    const newRetryCount = queueItem.retry_count + 1
    const shouldRetry = newRetryCount < queueItem.max_retries
    
    // Calculate next retry time with exponential backoff for ALL retries (prevents rate limiting)
    // 1st: 5s, 2nd: 15s, 3rd: 45s, 4th: 2min, 5th: 5min
    // After 5 retries: 15min, 30min, 1h, 2h, etc. (cap at 7 days)
    const backoffSeconds = newRetryCount <= 5
      ? [5, 15, 45, 120, 300][newRetryCount - 1] || 300
      : Math.min(900 * Math.pow(2, newRetryCount - 6), 7 * 24 * 3600) // Cap at 7 days

    const nextRetryAt = new Date(Date.now() + backoffSeconds * 1000)

    await (supabase
      .from('notion_sync_queue') as any)
      .update({
        status: shouldRetry ? 'pending' : 'failed',
        retry_count: newRetryCount,
        error_message: error.message || 'Unknown error',
        last_retry_at: new Date().toISOString(),
        next_retry_at: nextRetryAt.toISOString(),
        processed_at: new Date().toISOString(),
      })
      .eq('id', queueItem.id)

    return { success: false, error: error.message, shouldRetry }
  }
}

// Process queue items for a user
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { data: notionSettingsData, error: settingsError } = await supabase
      .from('user_notion_settings')
      .select('notion_api_key, notion_page_id, enabled')
      .eq('user_id', user.id)
      .eq('enabled', true)
      .maybeSingle()

    if (settingsError || !notionSettingsData) {
      return NextResponse.json({
        processed: 0,
        message: 'Notion integration not configured',
      })
    }

    const notionSettings = notionSettingsData as { notion_api_key: string; notion_page_id: string; enabled: boolean }

    const now = new Date().toISOString()
    const staleCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString()

    // Unstick only stale "processing" (stuck >2 min); don't touch items currently being worked on
    await (supabase
      .from('notion_sync_queue') as any)
      .update({ status: 'pending' })
      .eq('user_id', user.id)
      .eq('status', 'processing')
      .lt('updated_at', staleCutoff)

    // Fetch pending/failed/stale items (no bulk claim — we claim one-by-one inside processQueueItem)
    const { data: toProcess, error: queueError } = await (supabase
      .from('notion_sync_queue') as any)
      .select('*')
      .eq('user_id', user.id)
      .or(`and(status.eq.pending,retry_count.eq.0),and(status.eq.pending,retry_count.gt.0,retry_count.lt.5,or(next_retry_at.is.null,next_retry_at.lte.${now})),and(status.eq.failed,retry_count.lt.20,or(next_retry_at.is.null,next_retry_at.lte.${now})),and(status.eq.processing,updated_at.lt.${staleCutoff})`)
      .order('created_at', { ascending: true })
      .limit(10)

    if (queueError) throw queueError

    if (!toProcess || toProcess.length === 0) {
      return NextResponse.json({
        processed: 0,
        message: 'No pending items to process',
      })
    }

    let processed = 0
    let failed = 0
    for (const item of toProcess) {
      const result = await processQueueItem(supabase, item, notionSettings)
      if (result.success) processed++
      else failed++
    }

    return NextResponse.json({
      processed,
      failed,
      total: toProcess.length,
    })
  } catch (error: any) {
    console.error('Error processing Notion sync queue:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to process sync queue' },
      { status: 500 }
    )
  }
}

// Get queue status
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { data: stats, error } = await (supabase
      .from('notion_sync_queue') as any)
      .select('status')
      .eq('user_id', user.id)

    if (error) throw error

    const pending = stats?.filter((s: any) => s.status === 'pending').length || 0
    const processing = stats?.filter((s: any) => s.status === 'processing').length || 0
    const failed = stats?.filter((s: any) => s.status === 'failed').length || 0
    const readyToRetry = stats?.filter((s: any) => 
      s.status === 'failed' && 
      (!s.next_retry_at || new Date(s.next_retry_at) <= new Date())
    ).length || 0

    return NextResponse.json({
      pending,
      processing,
      failed,
      readyToRetry,
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to get queue status' },
      { status: 500 }
    )
  }
}
