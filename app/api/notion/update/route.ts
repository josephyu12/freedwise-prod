import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'
import { createClient } from '@/lib/supabase/server'
import { htmlToNotionBlocks, htmlToBlockText, normalizeForBlockCompare, getBlockText, findMatchingHighlightBlocks, buildNormalizedSearchStrings, flattenBlocksWithChildren, BLOCK_BOUNDARY, buildNormalizedBlockGroups } from '@/lib/notionBlocks'

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

    // Save top-level blocks before flattening (needed for position tracking during delete-and-recreate)
    const topLevelBlocks = [...blocks]

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
      normalizedOriginalPlainNoHtml,
      originalBlockText // BLOCK_BOUNDARY-separated text for per-block matching
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

    // Convert new HTML content to hierarchical Notion blocks (NOT flattened — preserves nested bullet structure)
    const newBlocks = htmlToNotionBlocks(htmlContent || text)

    if (newBlocks.length === 0) {
      return NextResponse.json(
        { error: 'Failed to convert content to Notion format' },
        { status: 400 }
      )
    }

    // Delete-and-recreate: delete all matching top-level blocks (children cascade),
    // then insert new hierarchical blocks at the same position.
    try {
      const matchingIds = new Set(matchingBlocks.map((b: any) => b.id))
      const topLevelMatchingBlocks = topLevelBlocks.filter((b: any) => matchingIds.has(b.id))

      // Find the block before the match group for insertion position
      const firstTopLevelMatchIndex = topLevelBlocks.findIndex((b: any) => matchingIds.has(b.id))
      const afterBlockId = firstTopLevelMatchIndex > 0 ? topLevelBlocks[firstTopLevelMatchIndex - 1].id : null

      // Delete top-level matching blocks (Notion cascades to children automatically)
      for (const block of topLevelMatchingBlocks) {
        await notion.blocks.delete({ block_id: block.id })
      }

      // Insert new hierarchical blocks at the correct position
      await notion.blocks.children.append({
        block_id: notionPageId,
        children: newBlocks,
        ...(afterBlockId ? { after: afterBlockId } : {}),
      })

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

