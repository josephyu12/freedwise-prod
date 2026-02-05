import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Client } from '@notionhq/client'
import { htmlToNotionBlocks } from '@/lib/notionBlocks'

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

      await notion.blocks.children.append({
        block_id: notionSettings.notion_page_id,
        children: blocks,
      })
    } else if (queueItem.operation_type === 'update') {
      // For update, use the ORIGINAL text stored in the queue item to find the block
      // The queue item stores both original and new text
      let originalText = (queueItem.original_html_content || queueItem.original_text || '').trim().toLowerCase()
      let originalPlainText = (queueItem.original_text || '').trim().toLowerCase()

      if (!originalText && !originalPlainText && queueItem.highlight_id) {
        // Fallback: get from database. Note: DB may already have new text if client updated before enqueue;
        // in that case matching may fail. Prefer always sending original from client.
        const { data: currentHighlight } = await (supabase
          .from('highlights') as any)
          .select('text, html_content')
          .eq('id', queueItem.highlight_id)
          .maybeSingle()
        
        if (currentHighlight) {
          const fallbackHtml = (currentHighlight.html_content || '').trim().toLowerCase()
          const fallbackPlain = (currentHighlight.text || '').trim().toLowerCase()
          if (fallbackHtml || fallbackPlain) {
            console.warn('Using current highlight text as fallback for Notion matching (original text not stored in queue)')
            originalText = fallbackHtml || originalText
            originalPlainText = fallbackPlain || originalPlainText
          }
        }
      }

      // Convert new content to Notion blocks
      const newBlocks = htmlToNotionBlocks(queueItem.html_content || queueItem.text)
      
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

      // Strip HTML for comparison: replace tags with space so list items (e.g. "</li><li>") don't get glued together
      const stripHtmlForCompare = (text: string): string => {
        return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
      }

      // Normalize the original text for comparison
      const normalizedOriginalText = normalizeText(originalText || originalPlainText)
      const normalizedOriginalPlainText = normalizeText(originalPlainText)
      
      // Find matching blocks (blocks that contain the original text)
      // Group blocks by empty line separators OR by block type transitions
      // List items (bulleted/numbered) should be grouped together
      const matchingBlocks: any[] = []
      let currentHighlightBlocks: any[] = []
      let foundMatch = false
      let exactMatch = false

      // Helper to check if a block is a list item
      const isListItem = (block: any) => 
        block.type === 'bulleted_list_item' || block.type === 'numbered_list_item'
      
      // Helper to check if a block is an empty paragraph
      const isEmptyParagraph = (block: any) =>
        block.type === 'paragraph' &&
        (!block.paragraph?.rich_text || block.paragraph.rich_text.length === 0)

      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i]
        const isEmpty = isEmptyParagraph(block)
        const isList = isListItem(block)
        
        // Determine if we should end the current group
        let shouldEndGroup = false

        if (isEmpty && currentHighlightBlocks.length > 0) {
          // Empty paragraph ends the group
          shouldEndGroup = true
        } else if (currentHighlightBlocks.length > 0 && !isEmpty) {
          // Check for type transition: but allow paragraph -> list transitions
          // (paragraphs from divs can precede lists in the same highlight)
          const lastBlock = currentHighlightBlocks[currentHighlightBlocks.length - 1]
          const currentIsList = isListItem(lastBlock)
          const currentIsParagraph = lastBlock.type === 'paragraph'
          
          // End group if:
          // 1. Transition from list to non-list (but allow list to paragraph if it's the first block)
          // 2. Transition from non-list to list, but NOT if current is paragraph (allow paragraph -> list)
          if (currentIsList && !isList) {
            // List to non-list ends the group
            shouldEndGroup = true
          } else if (!currentIsList && isList && !currentIsParagraph) {
            // Non-list to list ends the group, UNLESS current is a paragraph (allow paragraph -> list)
            shouldEndGroup = true
          }
        }
        
        if (shouldEndGroup) {
          // Check if this group of blocks matches the original highlight
          const combinedText = normalizeText(
            currentHighlightBlocks
              .map(getBlockText)
              .join(' ')
          )

          // Match using normalized text (strip HTML, replace tags with space so list items compare correctly)
          const normalizedCombined = stripHtmlForCompare(combinedText)
          const normalizedOriginalNoHtml = stripHtmlForCompare(normalizedOriginalText)
          const normalizedOriginalPlainNoHtml = stripHtmlForCompare(normalizedOriginalPlainText)

          const isExact = normalizedCombined === normalizedOriginalNoHtml || normalizedCombined === normalizedOriginalPlainNoHtml
          const isPartial = normalizedOriginalPlainNoHtml && (
            normalizedCombined.includes(normalizedOriginalPlainNoHtml) || normalizedOriginalPlainNoHtml.includes(normalizedCombined)
          )
          if (isExact || isPartial) {
            matchingBlocks.push(...currentHighlightBlocks)
            foundMatch = true
            exactMatch = isExact
            break
          }

          currentHighlightBlocks = []
          
          if (isEmpty) {
          continue
          }
        }

        // Add block to current group (unless it's an empty paragraph at the start)
        if (!isEmpty || currentHighlightBlocks.length > 0) {
          currentHighlightBlocks.push(block)
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
        const normalizedOriginalNoHtml = stripHtmlForCompare(normalizedOriginalText)
        const normalizedOriginalPlainNoHtml = stripHtmlForCompare(normalizedOriginalPlainText)

        const isExact = normalizedCombined === normalizedOriginalNoHtml || normalizedCombined === normalizedOriginalPlainNoHtml
        const isPartial = normalizedOriginalPlainNoHtml && (
          normalizedCombined.includes(normalizedOriginalPlainNoHtml) || normalizedOriginalPlainNoHtml.includes(normalizedCombined)
        )
        if (isExact || isPartial) {
          matchingBlocks.push(...currentHighlightBlocks)
          foundMatch = true
          exactMatch = isExact
        }
      }

      if (!foundMatch || matchingBlocks.length === 0) {
        throw new Error('Highlight not found in Notion page. It may have been deleted or moved.')
      }

      // Update the matching blocks with new content
      // For list items, update all matching items in place to preserve grouping
      const isListUpdate = matchingBlocks.length > 0 && 
        (matchingBlocks[0].type === 'bulleted_list_item' || matchingBlocks[0].type === 'numbered_list_item')
      
      if (isListUpdate && newBlocks.length > 0 && 
          (newBlocks[0].type === 'bulleted_list_item' || newBlocks[0].type === 'numbered_list_item')) {
        // Update list items in place - update each matching block with corresponding new block
        const minLength = Math.min(matchingBlocks.length, newBlocks.length)
        
        // Update matching blocks in place
        for (let i = 0; i < minLength; i++) {
          try {
            if (matchingBlocks[i].type === newBlocks[i].type) {
              // Same type, update in place (this preserves the block and updates formatting)
              const blockType = matchingBlocks[i].type
              const blockData = newBlocks[i][blockType]
              
              // Ensure rich_text exists and is an array
              if (blockData && blockData.rich_text && Array.isArray(blockData.rich_text)) {
        await notion.blocks.update({
                  block_id: matchingBlocks[i].id,
                  [blockType]: blockData,
        })
      } else {
                console.warn(`Block ${i} (${blockType}) missing rich_text array, skipping update`)
              }
            } else {
              // Type changed, delete and recreate
              await notion.blocks.delete({ block_id: matchingBlocks[i].id })
              // Insert after the previous block (or after the last updated block)
              const insertAfterId = i > 0 ? matchingBlocks[i - 1].id : null
              if (insertAfterId) {
                // Notion doesn't support inserting after a specific block directly
                // So we'll append and then reorder if needed, or just append to page
          await notion.blocks.children.append({
            block_id: notionSettings.notion_page_id,
                  children: [newBlocks[i]],
                })
              } else {
                await notion.blocks.children.append({
                  block_id: notionSettings.notion_page_id,
                  children: [newBlocks[i]],
                })
              }
            }
          } catch (error: any) {
            console.error(`Failed to update list item ${i}:`, error.message || error, error.response?.data || '')
            // Continue with other blocks even if one fails
          }
        }
        
        // Delete extra old blocks if there are more old than new
        for (let i = minLength; i < matchingBlocks.length; i++) {
        try {
          await notion.blocks.delete({ block_id: matchingBlocks[i].id })
        } catch (error) {
            console.warn(`Failed to delete extra old block ${i}:`, error)
          }
        }
        
        // Only append extra new blocks when match was exact. Insert after last matching block so bullets stay with their highlight.
        if (exactMatch && newBlocks.length > minLength) {
          const lastMatchingId = matchingBlocks[matchingBlocks.length - 1].id
          const extraBlocks = newBlocks.slice(minLength)
          try {
            await notion.blocks.children.append({
              block_id: notionSettings.notion_page_id,
              children: extraBlocks,
              after: lastMatchingId,
            })
          } catch (error: any) {
            console.warn('Failed to append new blocks after highlight:', error?.message || error)
          }
        }
      } else {
        // Non-list update: Update ALL matching blocks in place to preserve structure
        const minLength = Math.min(matchingBlocks.length, newBlocks.length)
        
        // Update matching blocks in place
        for (let i = 0; i < minLength; i++) {
          try {
            if (matchingBlocks[i].type === newBlocks[i].type) {
              // Same type, update in place (this preserves the block and updates formatting)
              const blockType = matchingBlocks[i].type
              const blockData = newBlocks[i][blockType]
              
              // Ensure rich_text exists and is an array
              if (blockData && blockData.rich_text && Array.isArray(blockData.rich_text)) {
                await notion.blocks.update({
                  block_id: matchingBlocks[i].id,
                  [blockType]: blockData,
                })
              } else {
                console.warn(`[SYNC UPDATE] Block ${i} (${blockType}) missing rich_text array, skipping update`)
              }
            } else {
              // Type changed, delete and recreate
              await notion.blocks.delete({ block_id: matchingBlocks[i].id })
              await notion.blocks.children.append({
                block_id: notionSettings.notion_page_id,
                children: [newBlocks[i]],
              })
            }
          } catch (error: any) {
            console.error(`Failed to update block ${i} (${matchingBlocks[i]?.type}):`, error.message || error, error.response?.data || '')
            // Don't re-throw for non-list updates to allow other blocks to update
          }
        }
        
        // Delete extra old blocks if there are more old than new
        for (let i = minLength; i < matchingBlocks.length; i++) {
          try {
            await notion.blocks.delete({ block_id: matchingBlocks[i].id })
          } catch (error) {
            console.warn(`Failed to delete extra old block ${i}:`, error)
          }
        }
        
        // Only append extra new blocks when match was exact. Insert after last matching block so bullets stay with their highlight.
        if (exactMatch && newBlocks.length > minLength) {
          const lastMatchingId = matchingBlocks[matchingBlocks.length - 1].id
          const extraBlocks = newBlocks.slice(minLength)
          try {
            await notion.blocks.children.append({
              block_id: notionSettings.notion_page_id,
              children: extraBlocks,
              after: lastMatchingId,
            })
          } catch (error: any) {
            console.warn('Failed to append new blocks after highlight:', error?.message || error)
          }
        }
      }
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

      // Function to extract plain text from HTML content (mimics how Notion blocks are structured)
      // This converts HTML to the same format as what we extract from Notion blocks
      const htmlToBlockText = (html: string): string => {
        if (!html) return ''
        
        // Simple HTML to text converter
        const stripHtml = (html: string): string => {
          return html
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim()
        }
        
        const textParts: string[] = []
        
        // Extract text before any HTML tags (like "Yogi Berra Bangers:" before <div>)
        // This handles cases where text appears directly before structured content
        const textBeforeTags = html.match(/^([^<]+?)(?=<[^>]+>)/)
        if (textBeforeTags && textBeforeTags[1]) {
          const beforeText = stripHtml(textBeforeTags[1])
          if (beforeText) {
            textParts.push(beforeText)
          }
        }
        
        // Extract paragraphs
        const pRegex = /<p[^>]*>(.*?)<\/p>/gi
        let pMatch
        while ((pMatch = pRegex.exec(html)) !== null) {
          const pText = stripHtml(pMatch[1])
          if (pText) {
            textParts.push(pText)
          }
        }
        
        // Extract list items from <ul> or <ol>
        const ulMatch = html.match(/<ul[^>]*>(.*?)<\/ul>/gis)
        if (ulMatch) {
          for (const match of ulMatch) {
            const liRegex = /<li[^>]*>(.*?)<\/li>/gis
            let liMatch
            while ((liMatch = liRegex.exec(match)) !== null) {
              const liText = stripHtml(liMatch[1])
              if (liText) {
                textParts.push(liText)
              }
            }
          }
        }
        
        const olMatch = html.match(/<ol[^>]*>(.*?)<\/ol>/gis)
        if (olMatch) {
          for (const match of olMatch) {
            const liRegex = /<li[^>]*>(.*?)<\/li>/gis
            let liMatch
            while ((liMatch = liRegex.exec(match)) !== null) {
              const liText = stripHtml(liMatch[1])
              if (liText) {
                textParts.push(liText)
              }
            }
          }
        }
        
        // If no structured content found, just strip HTML
        if (textParts.length === 0) {
          return stripHtml(html)
        }
        
        // Join parts with spaces (same as how we join Notion blocks)
        return textParts.join(' ')
      }
      
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

      // Helper to check if a block is a list item
      const isListItem = (block: any) => 
        block.type === 'bulleted_list_item' || block.type === 'numbered_list_item'
      
      // Helper to check if a block is an empty paragraph
      const isEmptyParagraph = (block: any) =>
        block.type === 'paragraph' &&
        (!block.paragraph?.rich_text || block.paragraph.rich_text.length === 0)

      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i]
        const isEmpty = isEmptyParagraph(block)
        const isList = isListItem(block)
        
        // Determine if we should end the current group
        let shouldEndGroup = false

        if (isEmpty && currentHighlightBlocks.length > 0) {
          // Empty paragraph ends the group
          shouldEndGroup = true
        } else if (currentHighlightBlocks.length > 0) {
          // Check for type transition: list to non-list or vice versa
          const currentIsList = isListItem(currentHighlightBlocks[0])
          if (currentIsList !== isList) {
            // Transition from list to non-list (or vice versa) ends the group
            shouldEndGroup = true
          }
        }
        
        if (shouldEndGroup) {
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
          // (fixes delete for single-block highlights like "Test" when followed by another block with no empty line)
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
    
    // Calculate next retry time with exponential backoff
    // 1st retry: 5 minutes, 2nd: 15 min, 3rd: 45 min, 4th: 2 hours, 5th: 6 hours
    // After 5 retries, continue with longer delays: 12h, 24h, 48h, etc.
    const backoffMinutes = newRetryCount <= 5 
      ? [5, 15, 45, 120, 360][newRetryCount - 1] || 360
      : Math.min(24 * 60 * Math.pow(2, newRetryCount - 6), 7 * 24 * 60) // Cap at 7 days
    
    const nextRetryAt = new Date()
    nextRetryAt.setMinutes(nextRetryAt.getMinutes() + backoffMinutes)

    await (supabase
      .from('notion_sync_queue') as any)
      .update({
        status: shouldRetry ? 'pending' : 'failed',
        retry_count: newRetryCount,
        error_message: error.message || 'Unknown error',
        last_retry_at: new Date().toISOString(),
        next_retry_at: shouldRetry ? null : nextRetryAt.toISOString(), // Only set next_retry_at for failed items
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
      .or(`and(status.eq.pending,retry_count.lt.5),and(status.eq.failed,retry_count.lt.20,or(next_retry_at.is.null,next_retry_at.lte.${now})),and(status.eq.processing,updated_at.lt.${staleCutoff})`)
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
