import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'
import { createClient } from '@/lib/supabase/server'
import { htmlToNotionBlocks, htmlToBlockText } from '@/lib/notionBlocks'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { highlightId, text, htmlContent } = await request.json()

    if (!highlightId || !text) {
      return NextResponse.json(
        { error: 'Highlight ID and text are required' },
        { status: 400 }
      )
    }

    // Get Notion credentials from environment
    const notionApiKey = process.env.NOTION_API_KEY
    const notionPageId = process.env.NOTION_PAGE_ID

    if (!notionApiKey || !notionPageId) {
      return NextResponse.json(
        { error: 'Notion API key and Page ID must be set in environment variables' },
        { status: 400 }
      )
    }

    // Get the original highlight from database to find it in Notion
    const { data: highlightData, error: highlightError } = await supabase
      .from('highlights')
      .select('text, html_content')
      .eq('id', highlightId)
      .single()

    if (highlightError || !highlightData) {
      return NextResponse.json(
        { error: 'Highlight not found' },
        { status: 404 }
      )
    }

    const highlight = highlightData as { text: string; html_content: string | null }

    // Initialize Notion client
    const notion = new Client({
      auth: notionApiKey,
    })

    // Fetch all blocks from the Notion page
    const blocks: any[] = []
    let cursor = undefined

    do {
      const response = await notion.blocks.children.list({
        block_id: notionPageId,
        start_cursor: cursor,
      })

      blocks.push(...response.results)
      cursor = response.next_cursor || undefined
    } while (cursor)

    // Find the block(s) that match the original highlight text (block-order so paragraph+list matches)
    const originalBlockText = highlight.html_content
      ? htmlToBlockText(highlight.html_content).trim().toLowerCase()
      : ''
    const originalPlainText = (highlight.text || '').trim().toLowerCase()
    // Use block-order text when we have html_content so paragraph+list order matches Notion; fall back to plain
    const originalText = originalBlockText || originalPlainText

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

    const stripHtmlForCompare = (text: string): string =>
      text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

    // Normalize so DB/plain text matches Notion block-order text (bullets, dashes, unicode)
    const normalizeForBlockCompare = (text: string): string =>
      stripHtmlForCompare(text)
        .replace(/\u2014/g, '-')
        .replace(/\u2013/g, '-')
        .replace(/\u00A0/g, ' ')
        .replace(/[\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
        .replace(/[\s•\u2022\u2043\u2219]+/g, ' ') // bullet chars -> space
        .replace(/\s*[-*]\s+/g, ' ') // "- " or "* " (list markers) -> space
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

    const normalizedOriginalText = normalizeText(originalText || originalPlainText)
    const normalizedOriginalPlainText = normalizeText(originalPlainText)

    // Find matching blocks (blocks that contain the original text)
    const matchingBlocks: any[] = []
    let currentHighlightBlocks: any[] = []
    let foundMatch = false
    let exactMatch = false // only append extra new blocks when exact (avoids duplicate at end on partial match)

    // Helper to check if a block is a list item
    const isListItem = (block: any) => 
      block.type === 'bulleted_list_item' || block.type === 'numbered_list_item'
    
    // Helper to check if a block is an empty paragraph
    const isEmptyParagraph = (block: any) =>
      block.type === 'paragraph' &&
      (!block.paragraph?.rich_text || block.paragraph.rich_text.length === 0)

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const isEmpty = isEmptyParagraph(block)
      const isList = isListItem(block)
      
      // Determine if we should end the current group
      let shouldEndGroup = false
      
      if (isEmpty && currentHighlightBlocks.length > 0) {
        // Empty paragraph ends the group
        shouldEndGroup = true
      } else if (currentHighlightBlocks.length > 0 && !isEmpty) {
        // Check for type transition: allow paragraph -> list (same highlight can be para + bullets)
        const lastBlock = currentHighlightBlocks[currentHighlightBlocks.length - 1]
        const currentIsList = isListItem(lastBlock)
        const currentIsParagraph = lastBlock.type === 'paragraph'
        if (currentIsList && !isList) {
          // List to non-list ends the group
          shouldEndGroup = true
        } else if (!currentIsList && isList && !currentIsParagraph) {
          // Non-list to list ends the group, unless current is paragraph (allow paragraph -> list)
          shouldEndGroup = true
        }
      }
      
      if (shouldEndGroup) {
        // Check if this group of blocks matches
        const combinedText = normalizeText(
          currentHighlightBlocks
            .map(getBlockText)
            .join(' ')
        )

        const normalizedCombined = normalizeForBlockCompare(combinedText)
        const normalizedOriginalNoHtml = normalizeForBlockCompare(normalizedOriginalText)
        const normalizedOriginalPlainNoHtml = normalizeForBlockCompare(normalizedOriginalPlainText)

        const isExact =
          normalizedCombined === normalizedOriginalNoHtml ||
          normalizedCombined === normalizedOriginalPlainNoHtml
        if (isExact) {
          matchingBlocks.push(...currentHighlightBlocks)
          foundMatch = true
          exactMatch = true
          break
        }

        currentHighlightBlocks = []
        if (isEmpty) {
          continue
        }
      }

      if (!isEmpty || currentHighlightBlocks.length > 0) {
        currentHighlightBlocks.push(block)
      }
    }

    if (!foundMatch && currentHighlightBlocks.length > 0) {
      const combinedText = normalizeText(
        currentHighlightBlocks
          .map(getBlockText)
          .join(' ')
      )

      const normalizedCombined = normalizeForBlockCompare(combinedText)
      const normalizedOriginalNoHtml = normalizeForBlockCompare(normalizedOriginalText)
      const normalizedOriginalPlainNoHtml = normalizeForBlockCompare(normalizedOriginalPlainText)

      const isExact =
        normalizedCombined === normalizedOriginalNoHtml ||
        normalizedCombined === normalizedOriginalPlainNoHtml
      if (isExact) {
        matchingBlocks.push(...currentHighlightBlocks)
        foundMatch = true
        exactMatch = true
      }
    }

    if (!foundMatch || matchingBlocks.length === 0) {
      return NextResponse.json(
        { 
          message: 'Highlight not found in Notion page. It may have been deleted or moved.',
          updated: false 
        },
        { status: 200 }
      )
    }

    // Convert new HTML content to Notion blocks
    const newBlocks = htmlToNotionBlocks(htmlContent || text)

    if (newBlocks.length === 0) {
      return NextResponse.json(
        { error: 'Failed to convert content to Notion format' },
        { status: 400 }
      )
    }

    // Update ALL matching blocks in place to preserve structure and formatting
    try {
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
              console.warn(`[UPDATE DIRECT] Block ${i} (${blockType}) missing rich_text array, skipping update`)
            }
          } else {
            // Type changed, delete and recreate
            await notion.blocks.delete({ block_id: matchingBlocks[i].id })
            await notion.blocks.children.append({
              block_id: notionPageId,
              children: [newBlocks[i]],
            })
          }
        } catch (error: any) {
          console.error(`Failed to update block ${i} (${matchingBlocks[i]?.type}):`, error.message || error, error.response?.data || '')
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
      
      // Only append extra new blocks when we had an exact match (avoids duplicating at end on partial match).
      // Insert after the last matching block so bullets stay with their highlight, not at bottom of page.
      if (exactMatch && newBlocks.length > minLength) {
        const lastMatchingId = matchingBlocks[matchingBlocks.length - 1].id
        const extraBlocks = newBlocks.slice(minLength)
        try {
          await notion.blocks.children.append({
            block_id: notionPageId,
            children: extraBlocks,
            after: lastMatchingId,
          })
        } catch (error: any) {
          console.warn('Failed to append new blocks after highlight:', error?.message || error)
        }
      }

      return NextResponse.json({
        message: 'Highlight updated in Notion successfully',
        updated: true,
      })
    } catch (updateError: any) {
      console.error('Error updating Notion block:', updateError)
      return NextResponse.json(
        { 
          error: `Failed to update Notion: ${updateError.message || 'Unknown error'}`,
          updated: false 
        },
        { status: 500 }
      )
    }
  } catch (error: any) {
    console.error('Error updating highlight in Notion:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to update highlight in Notion' },
      { status: 500 }
    )
  }
}

