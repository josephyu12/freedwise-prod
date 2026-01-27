import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Client } from '@notionhq/client'

// Import the HTML to Notion conversion functions
// We'll need to extract these to a shared utility or duplicate the logic
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
    strikethrough: boolean
    code: boolean
    link?: string
  }

  const segments: TextSegment[] = []
  let currentSegment: TextSegment = {
    text: '',
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    code: false,
  }

  // Stacks to track nested formatting tags
  const boldStack: boolean[] = []
  const italicStack: boolean[] = []
  const underlineStack: boolean[] = []
  const strikethroughStack: boolean[] = []
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
      } else if (tagName === 's' || tagName === 'strike' || tagName === 'del') {
        if (isClosing) {
          strikethroughStack.pop()
        } else {
          strikethroughStack.push(true)
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
      } else if (tagName === 'br') {
        currentSegment.text += '\n'
      }
      
      i = tagEnd + 1
    } else {
      // Regular text character - check if we need to start a new segment
      // due to formatting change
      const newFormatting = {
        bold: boldStack.length > 0,
        italic: italicStack.length > 0,
        underline: underlineStack.length > 0,
        strikethrough: strikethroughStack.length > 0,
        code: codeStack.length > 0,
      }
      
      const formattingChanged = 
        currentSegment.bold !== newFormatting.bold ||
        currentSegment.italic !== newFormatting.italic ||
        currentSegment.underline !== newFormatting.underline ||
        currentSegment.strikethrough !== newFormatting.strikethrough ||
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
          strikethrough: newFormatting.strikethrough,
          code: newFormatting.code,
        }
      } else {
        // Update formatting state
        currentSegment.bold = newFormatting.bold
        currentSegment.italic = newFormatting.italic
        currentSegment.underline = newFormatting.underline
        currentSegment.strikethrough = newFormatting.strikethrough
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
        strikethrough: segment.strikethrough,
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

// Helper function to parse list items, handling nested lists properly
function parseListItem(liHtml: string): { text: string; nestedLists: Array<{ type: 'ul' | 'ol'; content: string }> } {
  const nestedLists: Array<{ type: 'ul' | 'ol'; content: string }> = []
  let text = liHtml
  
  // Find and extract nested lists
  const nestedUlRegex = /<ul[^>]*>(.*?)<\/ul>/gis
  const nestedOlRegex = /<ol[^>]*>(.*?)<\/ol>/gis
  
  // Find all nested UL lists
  let match
  const ulMatches: Array<{ start: number; end: number; content: string }> = []
  while ((match = nestedUlRegex.exec(liHtml)) !== null) {
    ulMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1]
    })
  }
  
  // Find all nested OL lists
  const olMatches: Array<{ start: number; end: number; content: string }> = []
  while ((match = nestedOlRegex.exec(liHtml)) !== null) {
    olMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1]
    })
  }
  
  // Combine and sort by position
  const allMatches = [
    ...ulMatches.map(m => ({ ...m, type: 'ul' as const })),
    ...olMatches.map(m => ({ ...m, type: 'ol' as const }))
  ].sort((a, b) => a.start - b.start)
  
  // Remove nested lists from text and collect them
  let offset = 0
  for (const m of allMatches) {
    nestedLists.push({ type: m.type, content: m.content })
    // Remove from text
    const before = text.substring(0, m.start - offset)
    const after = text.substring(m.end - offset)
    text = before + after
    offset += (m.end - m.start)
  }
  
  return { text: text.trim(), nestedLists }
}

// Helper function to process list items, handling nested lists
function processListItems(listContent: string, listType: 'ul' | 'ol', blocks: any[]): void {
  // Parse list items by finding <li> tags and handling nested structures
  let pos = 0
  const liStartRegex = /<li[^>]*>/gi
  
  while (pos < listContent.length) {
    const remaining = listContent.substring(pos)
    const liStartMatch = liStartRegex.exec(remaining)
    
    if (!liStartMatch) break
    
    const liStartPos = pos + liStartMatch.index + liStartMatch[0].length
    let depth = 0
    let liEndPos = liStartPos
    let found = false
    
    // Find the matching </li> tag, accounting for nested <li> tags
    for (let i = liStartPos; i < listContent.length; i++) {
      if (listContent.substring(i).startsWith('<li')) {
        depth++
        i += 2 // Skip past '<li'
      } else if (listContent.substring(i).startsWith('</li>')) {
        if (depth === 0) {
          liEndPos = i
          found = true
          break
        }
        depth--
        i += 4 // Skip past '</li>'
      }
    }
    
    if (!found) break
    
    // Extract the list item content
    const liContent = listContent.substring(liStartPos, liEndPos)
    const { text, nestedLists } = parseListItem(liContent)
    
    // Process the text content
    const richText = htmlToNotionRichText(text)
    
    // Create the list item block
    const listItemType = listType === 'ul' ? 'bulleted_list_item' : 'numbered_list_item'
    const listItemBlock: any = {
      type: listItemType,
      [listItemType]: {
        rich_text: richText.length > 0 ? richText : []
      }
    }
    
    // Process nested lists if they exist
    if (nestedLists.length > 0) {
      const children: any[] = []
      for (const nested of nestedLists) {
        processListItems(nested.content, nested.type, children)
      }
      if (children.length > 0) {
        listItemBlock[listItemType].children = children
      }
    }
    
    // Only add if there's content or children
    if (richText.length > 0 || (listItemBlock[listItemType].children && listItemBlock[listItemType].children.length > 0)) {
      blocks.push(listItemBlock)
    }
    
    pos = liEndPos + 5 // Move past </li>
    liStartRegex.lastIndex = 0 // Reset regex
  }
}

function htmlToNotionBlocks(html: string): any[] {
  if (!html || html.trim() === '') {
    return [{
      type: 'paragraph',
      paragraph: { rich_text: [] },
    }]
  }

  const blocks: any[] = []
  
  // Process content sequentially to maintain order
  // Find all major content blocks with their positions
  interface ContentBlock {
    index: number
    type: 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre' | 'p' | 'div' | 'text'
    content: string
    fullMatch: string
  }
  
  const contentBlocks: ContentBlock[] = []
  
  // Helper function to find top-level lists (not nested)
  function findTopLevelLists(html: string, tag: 'ul' | 'ol'): Array<{ index: number; content: string; fullMatch: string }> {
    const results: Array<{ index: number; content: string; fullMatch: string }> = []
    const openTag = `<${tag}`
    const closeTag = `</${tag}>`
    let pos = 0
    
    while (pos < html.length) {
      const openIndex = html.indexOf(openTag, pos)
      if (openIndex === -1) break
      
      // Find the end of the opening tag
      const tagEndIndex = html.indexOf('>', openIndex)
      if (tagEndIndex === -1) break
      
      // Track depth to find matching closing tag
      let depth = 1
      let contentStart = tagEndIndex + 1
      let found = false
      
      for (let i = contentStart; i < html.length; i++) {
        if (html.substring(i).startsWith(openTag)) {
          depth++
          i += openTag.length - 1
        } else if (html.substring(i).startsWith(closeTag)) {
          depth--
          if (depth === 0) {
            const content = html.substring(contentStart, i)
            const fullMatch = html.substring(openIndex, i + closeTag.length)
            results.push({
              index: openIndex,
              content,
              fullMatch
            })
            pos = i + closeTag.length
            found = true
            break
          }
          i += closeTag.length - 1
        }
      }
      
      if (!found) break
    }
    
    return results
  }
  
  // Find all top-level lists with their positions
  const ulLists = findTopLevelLists(html, 'ul')
  for (const ul of ulLists) {
    contentBlocks.push({
      index: ul.index,
      type: 'ul',
      content: ul.content,
      fullMatch: ul.fullMatch,
    })
  }
  
  const olLists = findTopLevelLists(html, 'ol')
  for (const ol of olLists) {
    contentBlocks.push({
      index: ol.index,
      type: 'ol',
      content: ol.content,
      fullMatch: ol.fullMatch,
    })
  }
  
  // Find headings
  const h1Regex = /<h1[^>]*>(.*?)<\/h1>/gi
  let h1Match
  while ((h1Match = h1Regex.exec(html)) !== null) {
    contentBlocks.push({
      index: h1Match.index,
      type: 'h1',
      content: h1Match[1],
      fullMatch: h1Match[0],
    })
  }
  
  const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi
  let h2Match
  while ((h2Match = h2Regex.exec(html)) !== null) {
    contentBlocks.push({
      index: h2Match.index,
      type: 'h2',
      content: h2Match[1],
      fullMatch: h2Match[0],
    })
  }
  
  const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gi
  let h3Match
  while ((h3Match = h3Regex.exec(html)) !== null) {
    contentBlocks.push({
      index: h3Match.index,
      type: 'h3',
      content: h3Match[1],
      fullMatch: h3Match[0],
    })
  }
  
  // Find blockquotes
  const blockquoteRegex = /<blockquote[^>]*>(.*?)<\/blockquote>/gi
  let blockquoteMatch
  while ((blockquoteMatch = blockquoteRegex.exec(html)) !== null) {
    contentBlocks.push({
      index: blockquoteMatch.index,
      type: 'blockquote',
      content: blockquoteMatch[1],
      fullMatch: blockquoteMatch[0],
    })
  }
  
  // Find code blocks
  const preRegex = /<pre[^>]*>(.*?)<\/pre>/gis
  let preMatch
  while ((preMatch = preRegex.exec(html)) !== null) {
    contentBlocks.push({
      index: preMatch.index,
      type: 'pre',
      content: preMatch[1],
      fullMatch: preMatch[0],
    })
  }
  
  // Find paragraphs
  const pRegex = /<p[^>]*>(.*?)<\/p>/gi
  let pMatch
  while ((pMatch = pRegex.exec(html)) !== null) {
    contentBlocks.push({
      index: pMatch.index,
      type: 'p',
      content: pMatch[1],
      fullMatch: pMatch[0],
    })
  }

  // Find top-level divs (contenteditable often uses <div> per line)
  const divRegex = /<div[^>]*>(.*?)<\/div>/gi
  let divMatch
  while ((divMatch = divRegex.exec(html)) !== null) {
    contentBlocks.push({
      index: divMatch.index,
      type: 'div',
      content: divMatch[1],
      fullMatch: divMatch[0],
    })
  }
  
  // Sort by position
  contentBlocks.sort((a, b) => a.index - b.index)
  
  // Process blocks in order, handling text between them
  let lastIndex = 0
  for (const block of contentBlocks) {
    // Check for text before this block
    if (block.index > lastIndex) {
      const textBefore = html.substring(lastIndex, block.index).trim()
      if (textBefore) {
        // Split by <br> so each line becomes its own Notion paragraph
        const parts = textBefore.split(/<\s*br\s*\/?\s*>/gi)
        for (const part of parts) {
          const richText = htmlToNotionRichText(part)
          if (richText.length > 0) {
            blocks.push({
              type: 'paragraph',
              paragraph: { rich_text: richText },
            })
          }
        }
      }
    }
    
    // Process the block itself
    switch (block.type) {
      case 'ul': {
        processListItems(block.content, 'ul', blocks)
        break
      }
      case 'ol': {
        processListItems(block.content, 'ol', blocks)
        break
      }
      case 'h1': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0) {
          blocks.push({
            type: 'heading_1',
            heading_1: { rich_text: richText },
          })
        }
        break
      }
      case 'h2': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0) {
          blocks.push({
            type: 'heading_2',
            heading_2: { rich_text: richText },
          })
        }
        break
      }
      case 'h3': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0) {
          blocks.push({
            type: 'heading_3',
            heading_3: { rich_text: richText },
          })
        }
        break
      }
      case 'blockquote': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0) {
          blocks.push({
            type: 'quote',
            quote: { rich_text: richText },
          })
        }
        break
      }
      case 'pre': {
        const code = block.content.replace(/<[^>]*>/g, '').trim()
        if (code) {
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
        break
      }
      case 'p':
      case 'div': {
        // Notion uses separate paragraph blocks for line breaks; split by <br> and emit one per line
        const parts = block.content.split(/<\s*br\s*\/?\s*>/gi)
        for (const part of parts) {
          const richText = htmlToNotionRichText(part)
          if (richText.length > 0 || part.trim() === '') {
            blocks.push({
              type: 'paragraph',
              paragraph: { rich_text: richText },
            })
          }
        }
        break
      }
    }
    
    lastIndex = block.index + block.fullMatch.length
  }
  
  // Check for text after the last block
  if (lastIndex < html.length) {
    const textAfter = html.substring(lastIndex).trim()
    if (textAfter) {
      // Split by <br> so each line becomes its own Notion paragraph
      const parts = textAfter.split(/<\s*br\s*\/?\s*>/gi)
      for (const part of parts) {
        const richText = htmlToNotionRichText(part)
        if (richText.length > 0) {
          blocks.push({
            type: 'paragraph',
            paragraph: { rich_text: richText },
          })
        }
      }
    }
  }
  
  // If no blocks were created (e.g. HTML is only divs or br-separated), split by line breaks
  if (blocks.length === 0) {
    // Split by <br> or by </div><div so each "line" becomes one Notion paragraph
    const lineParts = html.split(/(?:<\s*br\s*\/?\s*>|<\/div>\s*<div[^>]*>)/gi)
    for (const part of lineParts) {
      const stripped = part.replace(/^<div[^>]*>/i, '').replace(/<\/div>$/i, '').trim()
      const richText = htmlToNotionRichText(stripped || part)
      if (richText.length > 0 || (stripped || part).trim() === '') {
        blocks.push({
          type: 'paragraph',
          paragraph: { rich_text: richText },
        })
      }
    }
  }
  // Final fallback: single paragraph from full html
  if (blocks.length === 0) {
    const plainText = html.replace(/<[^>]*>/g, '').trim()
    if (plainText) {
      const richText = htmlToNotionRichText(html)
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: richText },
      })
    }
  }
  
  if (blocks.length === 0) {
    return [{
      type: 'paragraph',
      paragraph: { rich_text: htmlToNotionRichText(html) },
    }]
  }
  
  return blocks
}

// Process a single queue item. Claims this one item to "processing" before work; if claim fails, returns without doing work.
async function processQueueItem(supabase: any, queueItem: any, notionSettings: { notion_api_key: string; notion_page_id: string; enabled: boolean }, now?: string, staleCutoff?: string) {
  const nowVal = now ?? new Date().toISOString()
  const staleVal = staleCutoff ?? new Date(Date.now() - 2 * 60 * 1000).toISOString()
  // Claim only this item so we never bulk-leave items stuck in "processing"
  const { data: claimed, error: claimErr } = await (supabase
    .from('notion_sync_queue') as any)
    .update({ status: 'processing' })
    .eq('id', queueItem.id)
    .or(`status.eq.pending,and(status.eq.failed,or(next_retry_at.is.null,next_retry_at.lte.${nowVal})),and(status.eq.processing,updated_at.lt.${staleVal})`)
    .select('id')

  if (claimErr || !claimed || claimed.length === 0) {
    return { success: false, error: 'Could not claim item (already taken or processed)' }
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
      const originalText = (queueItem.original_html_content || queueItem.original_text || '').trim().toLowerCase()
      const originalPlainText = (queueItem.original_text || '').trim().toLowerCase()

      if (!originalText && !originalPlainText) {
        // Fallback: try to get from database (but it will have the new text)
        const { data: currentHighlight } = await (supabase
          .from('highlights') as any)
          .select('text, html_content')
          .eq('id', queueItem.highlight_id)
          .maybeSingle()
        
        if (currentHighlight) {
          // Use current text as fallback (less accurate but better than nothing)
          const fallbackText = (currentHighlight.html_content || currentHighlight.text).trim().toLowerCase()
          if (fallbackText) {
            console.warn('Using current highlight text as fallback for Notion matching (original text not stored in queue)')
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

      // Normalize the original text for comparison
      const normalizedOriginalText = normalizeText(originalText || originalPlainText)
      const normalizedOriginalPlainText = normalizeText(originalPlainText)
      
      // Find matching blocks (blocks that contain the original text)
      // Group blocks by empty line separators OR by block type transitions
      // List items (bulleted/numbered) should be grouped together
      const matchingBlocks: any[] = []
      let currentHighlightBlocks: any[] = []
      let foundMatch = false

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

          // Match using normalized text comparison (strip HTML tags for comparison)
          const normalizedCombined = combinedText.replace(/<[^>]*>/g, '').trim()
          const normalizedOriginalNoHtml = normalizedOriginalText.replace(/<[^>]*>/g, '').trim()
          const normalizedOriginalPlainNoHtml = normalizedOriginalPlainText.replace(/<[^>]*>/g, '').trim()

          if (normalizedCombined === normalizedOriginalNoHtml || 
              normalizedCombined === normalizedOriginalPlainNoHtml ||
              (normalizedOriginalPlainNoHtml && (
                normalizedCombined.includes(normalizedOriginalPlainNoHtml) || 
                normalizedOriginalPlainNoHtml.includes(normalizedCombined)
              ))) {
            matchingBlocks.push(...currentHighlightBlocks)
            foundMatch = true
            break
          }

          currentHighlightBlocks = []
          
          // If this was an empty paragraph, skip it and continue
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

        // Match using normalized text comparison (strip HTML tags for comparison)
        const normalizedCombined = combinedText.replace(/<[^>]*>/g, '').trim()
        const normalizedOriginalNoHtml = normalizedOriginalText.replace(/<[^>]*>/g, '').trim()
        const normalizedOriginalPlainNoHtml = normalizedOriginalPlainText.replace(/<[^>]*>/g, '').trim()

        if (normalizedCombined === normalizedOriginalNoHtml || 
            normalizedCombined === normalizedOriginalPlainNoHtml ||
            (normalizedOriginalPlainNoHtml && (
              normalizedCombined.includes(normalizedOriginalPlainNoHtml) || 
              normalizedOriginalPlainNoHtml.includes(normalizedCombined)
            ))) {
          matchingBlocks.push(...currentHighlightBlocks)
          foundMatch = true
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
        
        // Add extra new blocks if there are more new than old
        // Insert them after the last matching block
        const lastMatchingBlockId = matchingBlocks.length > 0 ? matchingBlocks[matchingBlocks.length - 1].id : null
        for (let i = minLength; i < newBlocks.length; i++) {
          try {
            // Notion API doesn't support inserting after a specific block
            // So we append to the page - they should appear in the right place if we're updating in order
          await notion.blocks.children.append({
            block_id: notionSettings.notion_page_id,
            children: [newBlocks[i]],
          })
        } catch (error) {
            console.warn(`Failed to append new list item ${i}:`, error)
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
        
        // Add extra new blocks if there are more new than old
        for (let i = minLength; i < newBlocks.length; i++) {
          try {
            await notion.blocks.children.append({
              block_id: notionSettings.notion_page_id,
              children: [newBlocks[i]],
            })
          } catch (error) {
            console.warn(`Failed to append new block ${i}:`, error)
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

          // Match using normalized text comparison (strip HTML tags for comparison)
          const normalizedCombined = combinedText.replace(/<[^>]*>/g, '').trim()
          const normalizedDeleteNoHtml = normalizedDeleteText.replace(/<[^>]*>/g, '').trim()
          const normalizedDeletePlainNoHtml = normalizedDeletePlainText.replace(/<[^>]*>/g, '').trim()

          if (normalizedCombined === normalizedDeleteNoHtml || 
              normalizedCombined === normalizedDeletePlainNoHtml ||
              (normalizedDeletePlainNoHtml && (
                normalizedCombined.includes(normalizedDeletePlainNoHtml) || 
                normalizedDeletePlainNoHtml.includes(normalizedCombined)
              ))) {
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
          // Non-empty block - add to current group
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

        // Match using normalized text comparison (strip HTML tags for comparison)
        const normalizedCombined = combinedText.replace(/<[^>]*>/g, '').trim()
        const normalizedDeleteNoHtml = normalizedDeleteText.replace(/<[^>]*>/g, '').trim()
        const normalizedDeletePlainNoHtml = normalizedDeletePlainText.replace(/<[^>]*>/g, '').trim()

        if (normalizedCombined === normalizedDeleteNoHtml || 
            normalizedCombined === normalizedDeletePlainNoHtml ||
            (normalizedDeletePlainNoHtml && (
              normalizedCombined.includes(normalizedDeletePlainNoHtml) || 
              normalizedDeletePlainNoHtml.includes(normalizedCombined)
            ))) {
          matchingBlocks.push(...currentHighlightBlocks)
          foundMatch = true
        }
      }

      if (!foundMatch || matchingBlocks.length === 0) {
        throw new Error('Highlight not found in Notion page. It may have already been deleted.')
      }

      // Delete all matching blocks
      for (const block of matchingBlocks) {
        try {
          await notion.blocks.delete({ block_id: block.id })
        } catch (error) {
          console.warn(`Failed to delete block ${block.id}:`, error)
        }
      }

      // Delete the empty line separator (prefer the one after, but use before if after doesn't exist)
      const emptyLineToDelete = emptyLineAfter || emptyLineBefore
      if (emptyLineToDelete && emptyLineToDelete.type === 'paragraph' && 
          (!emptyLineToDelete.paragraph?.rich_text || emptyLineToDelete.paragraph.rich_text.length === 0)) {
        try {
          await notion.blocks.delete({ block_id: emptyLineToDelete.id })
        } catch (error) {
          console.warn(`Failed to delete empty line separator:`, error)
        }
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
      const result = await processQueueItem(supabase, item, notionSettings, now, staleCutoff)
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
