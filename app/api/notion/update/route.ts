import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'
import { createClient } from '@/lib/supabase/server'

// Simple HTML to text converter (removes HTML tags)
function stripHtml(html: string): string {
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

// Convert HTML to Notion rich text format (simplified version)
function htmlToNotionRichText(html: string): any[] {
  if (!html || html.trim() === '') {
    return []
  }

  const richText: any[] = []
  
  // Simple regex-based parsing for basic formatting
  // This handles nested tags by processing from innermost to outermost
  let remaining = html
  
  // Extract links first (they may contain other formatting)
  const linkRegex = /<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi
  const links: Array<{ start: number; end: number; href: string; content: string }> = []
  let linkMatch
  
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    links.push({
      start: linkMatch.index,
      end: linkMatch.index + linkMatch[0].length,
      href: linkMatch[1],
      content: linkMatch[2],
    })
  }
  
  // Process text segments
  function processSegment(text: string, annotations: any = {}): void {
    if (!text || text.trim() === '') return
    
    // Check if this segment is within a link
    const segmentStart = html.indexOf(text)
    const segmentEnd = segmentStart + text.length
    const containingLink = links.find(
      (link) => segmentStart >= link.start && segmentEnd <= link.end
    )
    
    if (containingLink && segmentStart === html.indexOf(containingLink.content)) {
      // This is link content
      richText.push({
        type: 'text',
        text: { content: text, link: { url: containingLink.href } },
        annotations: {
          bold: annotations.bold || false,
          italic: annotations.italic || false,
          strikethrough: false,
          underline: annotations.underline || false,
          code: annotations.code || false,
          color: 'default',
        },
        plain_text: text,
      })
    } else {
      richText.push({
        type: 'text',
        text: { content: text },
        annotations: {
          bold: annotations.bold || false,
          italic: annotations.italic || false,
          strikethrough: false,
          underline: annotations.underline || false,
          code: annotations.code || false,
          color: 'default',
        },
        plain_text: text,
      })
    }
  }
  
  // Extract formatted segments
  // Process bold
  const boldRegex = /<strong[^>]*>(.*?)<\/strong>|<b[^>]*>(.*?)<\/b>/gi
  let processed = html
  const boldMatches: Array<{ content: string; start: number }> = []
  
  let match
  while ((match = boldRegex.exec(html)) !== null) {
    boldMatches.push({
      content: match[1] || match[2],
      start: match.index,
    })
  }
  
  // For simplicity, extract plain text and apply basic formatting
  // This is a simplified version - for full support, consider using a proper HTML parser library
  const plainText = stripHtml(html)
  
  if (plainText) {
    // Check if the original HTML had bold/italic/underline
    const hasBold = /<strong|<b/i.test(html)
    const hasItalic = /<em|<i/i.test(html)
    const hasUnderline = /<u/i.test(html)
    const hasCode = /<code/i.test(html)
    
    processSegment(plainText, {
      bold: hasBold,
      italic: hasItalic,
      underline: hasUnderline,
      code: hasCode,
    })
  }
  
  return richText.length > 0 ? richText : [{
    type: 'text',
    text: { content: plainText || html },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
    },
    plain_text: plainText || html,
  }]
}

// Convert HTML to Notion blocks (simplified regex-based parser)
function htmlToNotionBlocks(html: string): any[] {
  if (!html || html.trim() === '') {
    return [{
      type: 'paragraph',
      paragraph: { rich_text: [] },
    }]
  }

  const blocks: any[] = []
  
  // Extract list items separately
  const ulRegex = /<ul[^>]*>(.*?)<\/ul>/gis
  const olRegex = /<ol[^>]*>(.*?)<\/ol>/gis
  
  // Process unordered lists
  let ulMatch
  while ((ulMatch = ulRegex.exec(html)) !== null) {
    const listContent = ulMatch[1]
    const liRegex = /<li[^>]*>(.*?)<\/li>/gis
    let liMatch
    while ((liMatch = liRegex.exec(listContent)) !== null) {
      const richText = htmlToNotionRichText(liMatch[1])
      if (richText.length > 0) {
        blocks.push({
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: richText },
        })
      }
    }
  }
  
  // Process ordered lists
  let olMatch
  while ((olMatch = olRegex.exec(html)) !== null) {
    const listContent = olMatch[1]
    const liRegex = /<li[^>]*>(.*?)<\/li>/gis
    let liMatch
    while ((liMatch = liRegex.exec(listContent)) !== null) {
      const richText = htmlToNotionRichText(liMatch[1])
      if (richText.length > 0) {
        blocks.push({
          type: 'numbered_list_item',
          numbered_list_item: { rich_text: richText },
        })
      }
    }
  }
  
  // Remove processed lists from HTML
  let remainingHtml = html
    .replace(/<ul[^>]*>.*?<\/ul>/gis, '')
    .replace(/<ol[^>]*>.*?<\/ol>/gis, '')
  
  // Process headings
  const h1Regex = /<h1[^>]*>(.*?)<\/h1>/gi
  let h1Match
  while ((h1Match = h1Regex.exec(remainingHtml)) !== null) {
    const richText = htmlToNotionRichText(h1Match[1])
    if (richText.length > 0) {
      blocks.push({
        type: 'heading_1',
        heading_1: { rich_text: richText },
      })
    }
    remainingHtml = remainingHtml.replace(h1Match[0], '')
  }
  
  const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi
  let h2Match
  while ((h2Match = h2Regex.exec(remainingHtml)) !== null) {
    const richText = htmlToNotionRichText(h2Match[1])
    if (richText.length > 0) {
      blocks.push({
        type: 'heading_2',
        heading_2: { rich_text: richText },
      })
    }
    remainingHtml = remainingHtml.replace(h2Match[0], '')
  }
  
  const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gi
  let h3Match
  while ((h3Match = h3Regex.exec(remainingHtml)) !== null) {
    const richText = htmlToNotionRichText(h3Match[1])
    if (richText.length > 0) {
      blocks.push({
        type: 'heading_3',
        heading_3: { rich_text: richText },
      })
    }
    remainingHtml = remainingHtml.replace(h3Match[0], '')
  }
  
  // Process blockquotes
  const blockquoteRegex = /<blockquote[^>]*>(.*?)<\/blockquote>/gi
  let blockquoteMatch
  while ((blockquoteMatch = blockquoteRegex.exec(remainingHtml)) !== null) {
    const richText = htmlToNotionRichText(blockquoteMatch[1])
    if (richText.length > 0) {
      blocks.push({
        type: 'quote',
        quote: { rich_text: richText },
      })
    }
    remainingHtml = remainingHtml.replace(blockquoteMatch[0], '')
  }
  
  // Process code blocks
  const preRegex = /<pre[^>]*>(.*?)<\/pre>/gis
  let preMatch
  while ((preMatch = preRegex.exec(remainingHtml)) !== null) {
    const code = stripHtml(preMatch[1])
    if (code.trim()) {
      blocks.push({
        type: 'code',
        code: {
          rich_text: [{
            type: 'text',
            text: { content: code },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: code,
          }],
          language: 'plain text',
        },
      })
    }
    remainingHtml = remainingHtml.replace(preMatch[0], '')
  }
  
  // Process paragraphs (what's left)
  const pRegex = /<p[^>]*>(.*?)<\/p>/gi
  let pMatch
  const processedParagraphs = new Set<number>()
  
  while ((pMatch = pRegex.exec(remainingHtml)) !== null) {
    const richText = htmlToNotionRichText(pMatch[1])
    if (richText.length > 0 || pMatch[1].trim() === '') {
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: richText },
      })
    }
    processedParagraphs.add(pMatch.index)
  }
  
  // If no blocks were created, create a paragraph with the remaining content
  if (blocks.length === 0) {
    const plainText = stripHtml(html)
    if (plainText.trim()) {
      const richText = htmlToNotionRichText(html)
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: richText },
      })
    }
  }
  
  return blocks.length > 0 ? blocks : [{
    type: 'paragraph',
    paragraph: { rich_text: [] },
  }]
}

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

    // Find the block(s) that match the original highlight text
    // We'll search by comparing plain text content
    const originalText = (highlight.html_content || highlight.text).trim().toLowerCase()
    const originalPlainText = highlight.text.trim().toLowerCase()

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

    // Normalize the original text for comparison
    const normalizedOriginalText = normalizeText(originalText || originalPlainText)
    const normalizedOriginalPlainText = normalizeText(originalPlainText)

    // Find matching blocks (blocks that contain the original text)
    const matchingBlocks: any[] = []
    let currentHighlightBlocks: any[] = []
    let foundMatch = false

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const isParagraph = block.type === 'paragraph'
      const isEmpty = isParagraph &&
        (!block.paragraph.rich_text || block.paragraph.rich_text.length === 0)

      if (isEmpty && currentHighlightBlocks.length > 0) {
        // Check if this group of blocks matches
        const combinedText = normalizeText(
          currentHighlightBlocks
            .map(getBlockText)
            .join(' ')
        )

        if (combinedText === normalizedOriginalText || 
            combinedText === normalizedOriginalPlainText ||
            (normalizedOriginalPlainText && (
              combinedText.includes(normalizedOriginalPlainText) || 
              normalizedOriginalPlainText.includes(combinedText)
            ))) {
          matchingBlocks.push(...currentHighlightBlocks)
          foundMatch = true
        }

        currentHighlightBlocks = []
        continue
      }

      if (!isEmpty || currentHighlightBlocks.length > 0) {
        currentHighlightBlocks.push(block)
      }
    }

    // Check the last group
    if (currentHighlightBlocks.length > 0) {
      const combinedText = normalizeText(
        currentHighlightBlocks
          .map(getBlockText)
          .join(' ')
      )

      if (combinedText === normalizedOriginalText || 
          combinedText === normalizedOriginalPlainText ||
          (normalizedOriginalPlainText && (
            combinedText.includes(normalizedOriginalPlainText) || 
            normalizedOriginalPlainText.includes(combinedText)
          ))) {
        matchingBlocks.push(...currentHighlightBlocks)
        foundMatch = true
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

    // Update the first matching block and delete the rest
    // We'll replace the first block's content and delete subsequent blocks
    try {
      // Update the first block
      const firstBlock = matchingBlocks[0]
      const firstNewBlock = newBlocks[0]

      if (firstBlock.type === firstNewBlock.type) {
        // Same type, update in place
        await notion.blocks.update({
          block_id: firstBlock.id,
          [firstBlock.type]: firstNewBlock[firstBlock.type],
        })
      } else {
        // Different type, delete and recreate
        await notion.blocks.delete({ block_id: firstBlock.id })
        await notion.blocks.children.append({
          block_id: notionPageId,
          children: [firstNewBlock],
        })
      }

      // Delete remaining old blocks
      for (let i = 1; i < matchingBlocks.length; i++) {
        try {
          await notion.blocks.delete({ block_id: matchingBlocks[i].id })
        } catch (error) {
          console.warn(`Failed to delete block ${matchingBlocks[i].id}:`, error)
        }
      }

      // Add remaining new blocks
      for (let i = 1; i < newBlocks.length; i++) {
        try {
          await notion.blocks.children.append({
            block_id: notionPageId,
            children: [newBlocks[i]],
          })
        } catch (error) {
          console.warn(`Failed to append block:`, error)
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

