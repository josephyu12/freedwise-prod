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

// Convert HTML to Notion rich text format (properly handles nested formatting)
function htmlToNotionRichText(html: string): any[] {
  if (!html || html.trim() === '') {
    return []
  }

  // Helper to decode HTML entities (server-safe)
  function decodeHtmlEntities(text: string): string {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&#x60;/g, '`')
      .replace(/&#x3D;/g, '=')
  }

  // Parse HTML and extract text segments with their formatting
  interface TextSegment {
    text: string
    bold: boolean
    italic: boolean
    underline: boolean
    code: boolean
    link?: string
  }

  const segments: TextSegment[] = []
  let currentSegment: TextSegment = {
    text: '',
    bold: false,
    italic: false,
    underline: false,
    code: false,
  }

  // Stacks to track nested formatting tags
  const boldStack: boolean[] = []
  const italicStack: boolean[] = []
  const underlineStack: boolean[] = []
  const codeStack: boolean[] = []
  let currentLink: string | null = null

  // Parse HTML character by character, tracking formatting state
  let i = 0
  while (i < html.length) {
    if (html[i] === '<') {
      const tagEnd = html.indexOf('>', i)
      if (tagEnd === -1) {
        // Malformed tag, treat as text
        currentSegment.text += html[i]
        i++
        continue
      }
      
      const tag = html.substring(i, tagEnd + 1)
      const tagNameMatch = tag.match(/<\/?(\w+)/i)
      if (!tagNameMatch) {
        i = tagEnd + 1
        continue
      }
      
      const tagName = tagNameMatch[1].toLowerCase()
      const isClosing = tag.startsWith('</')
      
      // Handle formatting tags - update stacks first
      if (tagName === 'strong' || tagName === 'b') {
        if (isClosing) {
          boldStack.pop()
        } else {
          boldStack.push(true)
        }
      } else if (tagName === 'em' || tagName === 'i') {
        if (isClosing) {
          italicStack.pop()
        } else {
          italicStack.push(true)
        }
      } else if (tagName === 'u') {
        if (isClosing) {
          underlineStack.pop()
        } else {
          underlineStack.push(true)
        }
      } else if (tagName === 'code') {
        if (isClosing) {
          codeStack.pop()
        } else {
          codeStack.push(true)
        }
      } else if (tagName === 'a') {
        if (isClosing) {
          currentLink = null
        } else {
          // Extract href
          const hrefMatch = tag.match(/href=["']([^"']+)["']/i)
          if (hrefMatch) {
            currentLink = hrefMatch[1]
          }
        }
      }
      
      i = tagEnd + 1
    } else {
      // Regular text character - check if we need to start a new segment
      // due to formatting change
      const newFormatting = {
        bold: boldStack.length > 0,
        italic: italicStack.length > 0,
        underline: underlineStack.length > 0,
        code: codeStack.length > 0,
      }
      
      const formattingChanged = 
        currentSegment.bold !== newFormatting.bold ||
        currentSegment.italic !== newFormatting.italic ||
        currentSegment.underline !== newFormatting.underline ||
        currentSegment.code !== newFormatting.code ||
        (currentLink !== null && currentSegment.link !== currentLink) ||
        (currentLink === null && currentSegment.link !== undefined)
      
      if (formattingChanged && currentSegment.text) {
        segments.push({ ...currentSegment, link: currentLink || undefined })
        currentSegment = {
          text: '',
          bold: newFormatting.bold,
          italic: newFormatting.italic,
          underline: newFormatting.underline,
          code: newFormatting.code,
        }
      } else {
        // Update formatting state
        currentSegment.bold = newFormatting.bold
        currentSegment.italic = newFormatting.italic
        currentSegment.underline = newFormatting.underline
        currentSegment.code = newFormatting.code
      }
      
      currentSegment.text += html[i]
      i++
    }
  }

  // Add final segment if it has text
  if (currentSegment.text) {
    segments.push({ ...currentSegment, link: currentLink || undefined })
  }

  // Convert segments to Notion rich text format
  const richText: any[] = []
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    // Decode HTML entities but preserve spaces between segments
    let decodedText = decodeHtmlEntities(segment.text)
    
    // Only trim leading whitespace from the very first segment
    if (i === 0) {
      decodedText = decodedText.replace(/^\s+/, '')
    }
    // Only trim trailing whitespace from the very last segment
    if (i === segments.length - 1) {
      decodedText = decodedText.replace(/\s+$/, '')
    }
    
    // Skip completely empty segments (but preserve segments that only have spaces in the middle)
    if (!decodedText.trim() && decodedText.length === 0) continue

    richText.push({
      type: 'text',
      text: segment.link ? { content: decodedText, link: { url: segment.link } } : { content: decodedText },
      annotations: {
        bold: segment.bold,
        italic: segment.italic,
        strikethrough: false,
        underline: segment.underline,
        code: segment.code,
        color: 'default',
      },
      plain_text: decodedText,
    })
  }

  // If no segments were created, return a plain text segment
  if (richText.length === 0) {
    const plainText = html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim()
    
    if (plainText) {
      richText.push({
        type: 'text',
        text: { content: plainText },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default',
        },
        plain_text: plainText,
      })
    }
  }

  return richText.length > 0 ? richText : []
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

