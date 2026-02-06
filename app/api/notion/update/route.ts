import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'
import { createClient } from '@/lib/supabase/server'
import { htmlToNotionBlocks, htmlToBlockText, normalizeForBlockCompare, getBlockText, findMatchingHighlightBlocks, buildNormalizedSearchStrings, flattenBlocksWithChildren, flattenBlocksForSync, BLOCK_BOUNDARY, buildNormalizedBlockGroups } from '@/lib/notionBlocks'

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

    // Fetch all blocks from the Notion page (top-level only first)
    let blocks: any[] = []
    let cursor = undefined
    do {
      const response = await notion.blocks.children.list({
        block_id: notionPageId,
        start_cursor: cursor,
      })
      blocks.push(...response.results)
      cursor = response.next_cursor || undefined
    } while (cursor)

    // Include nested/indented children so sub-bullets are in the list and can match
    blocks = await flattenBlocksWithChildren(notion, blocks)

    const originalBlockText = highlight.html_content
      ? htmlToBlockText(highlight.html_content).trim().toLowerCase()
      : ''
    const originalPlainText = (highlight.text || '').trim().toLowerCase()
    const { normalizedOriginalNoHtml, normalizedOriginalPlainNoHtml } = buildNormalizedSearchStrings(originalBlockText, originalPlainText)

    const debugPayload = {
      searchFromBlockOrder: normalizedOriginalNoHtml || null,
      searchFromPlainText: normalizedOriginalPlainNoHtml !== normalizedOriginalNoHtml ? normalizedOriginalPlainNoHtml : undefined,
      sampleNotionBlockGroups: [] as string[],
    }

    const { matchingBlocks, foundMatch, exactMatch } = findMatchingHighlightBlocks(
      blocks,
      normalizedOriginalNoHtml,
      normalizedOriginalPlainNoHtml
    )

    if (!foundMatch || matchingBlocks.length === 0) {
      debugPayload.sampleNotionBlockGroups = buildNormalizedBlockGroups(blocks).slice(-8)
      console.warn('[notion/update] Highlight not found. Full debug (last 8 block groups):', JSON.stringify(debugPayload, null, 2))
      return NextResponse.json(
        {
          message: 'Highlight not found in Notion page. It may have been deleted or moved.',
          updated: false,
          debug: debugPayload,
        },
        { status: 200 }
      )
    }

    if (foundMatch && matchingBlocks.length > 0) {
      debugPayload.sampleNotionBlockGroups = [normalizeForBlockCompare(matchingBlocks.map(getBlockText).join(BLOCK_BOUNDARY))]
    }
    console.warn('[notion/update] Highlight found. Full debug:', JSON.stringify(debugPayload, null, 2))

    // Convert new HTML content to Notion blocks; flatten so nested list items align with Notion's flat list
    const newBlocks = htmlToNotionBlocks(htmlContent || text)
    const flatNewBlocks = flattenBlocksForSync(newBlocks)

    if (flatNewBlocks.length === 0) {
      return NextResponse.json(
        { error: 'Failed to convert content to Notion format' },
        { status: 400 }
      )
    }

    // Update ALL matching blocks in place to preserve structure and formatting
    try {
      const minLength = Math.min(matchingBlocks.length, flatNewBlocks.length)
      
      // Update matching blocks in place
      for (let i = 0; i < minLength; i++) {
        try {
          if (matchingBlocks[i].type === flatNewBlocks[i].type) {
            // Same type, update in place (this preserves the block and updates formatting)
            const blockType = matchingBlocks[i].type
            const blockData = flatNewBlocks[i][blockType]
            
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
              children: [flatNewBlocks[i]],
            })
          }
        } catch (error: any) {
          console.error(`Failed to update block ${i} (${matchingBlocks[i]?.type}):`, error.message || error, error.response?.data || '')
          // Continue with other blocks even if one fails
        }
      }
      
      // Delete extra old blocks only when they're not list items (never delete nested bullets; new content may have omitted them)
      for (let i = minLength; i < matchingBlocks.length; i++) {
        const block = matchingBlocks[i]
        if (block.type === 'bulleted_list_item' || block.type === 'numbered_list_item') continue
        try {
          await notion.blocks.delete({ block_id: block.id })
        } catch (error) {
          console.warn(`Failed to delete extra old block ${i}:`, error)
        }
      }
      
      // Only append extra new blocks when we had an exact match. If last matching block is a list item, append as its children (nested bullet); else append to page after it.
      if (exactMatch && flatNewBlocks.length > minLength) {
        const lastMatching = matchingBlocks[matchingBlocks.length - 1]
        const lastMatchingId = lastMatching.id
        const extraBlocks = flatNewBlocks.slice(minLength)
        const isLastList = lastMatching.type === 'bulleted_list_item' || lastMatching.type === 'numbered_list_item'
        try {
          if (isLastList) {
            await notion.blocks.children.append({
              block_id: lastMatchingId,
              children: extraBlocks,
            })
          } else {
            await notion.blocks.children.append({
              block_id: notionPageId,
              children: extraBlocks,
              after: lastMatchingId,
            })
          }
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

