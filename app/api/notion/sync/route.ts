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
    type: 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre' | 'p' | 'text'
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
  
  // Sort by position
  contentBlocks.sort((a, b) => a.index - b.index)
  
  // Process blocks in order, handling text between them
  let lastIndex = 0
  for (const block of contentBlocks) {
    // Check for text before this block
    if (block.index > lastIndex) {
      const textBefore = html.substring(lastIndex, block.index).trim()
      if (textBefore) {
        // Remove any HTML tags to get plain text
        const plainText = textBefore.replace(/<[^>]*>/g, '').trim()
        if (plainText) {
          const richText = htmlToNotionRichText(plainText)
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
      case 'p': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0 || block.content.trim() === '') {
          blocks.push({
            type: 'paragraph',
            paragraph: { rich_text: richText },
          })
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
      const plainText = textAfter.replace(/<[^>]*>/g, '').trim()
      if (plainText) {
        const richText = htmlToNotionRichText(plainText)
        if (richText.length > 0) {
          blocks.push({
            type: 'paragraph',
            paragraph: { rich_text: richText },
          })
        }
      }
    }
  }
  
  // If no blocks were created, create a paragraph with the entire content
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
  
  return blocks.length > 0 ? blocks : [{
    type: 'paragraph',
    paragraph: { rich_text: htmlToNotionRichText(html) },
  }]
}

// Process a single queue item
async function processQueueItem(supabase: any, queueItem: any, notionSettings: { notion_api_key: string; notion_page_id: string; enabled: boolean }) {
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
      // Group blocks by empty line separators (like in the import logic)
      const matchingBlocks: any[] = []
      let currentHighlightBlocks: any[] = []
      let foundMatch = false

      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i]
        const isParagraph = block.type === 'paragraph'
        const isEmpty = isParagraph &&
          (!block.paragraph?.rich_text || block.paragraph.rich_text.length === 0)

        if (isEmpty && currentHighlightBlocks.length > 0) {
          // Check if this group of blocks matches the original highlight
          const combinedText = normalizeText(
            currentHighlightBlocks
              .map(getBlockText)
              .join(' ')
          )

          // Match using normalized text comparison
          if (combinedText === normalizedOriginalText || 
              combinedText === normalizedOriginalPlainText ||
              (normalizedOriginalPlainText && (
                combinedText.includes(normalizedOriginalPlainText) || 
                normalizedOriginalPlainText.includes(combinedText)
              ))) {
            matchingBlocks.push(...currentHighlightBlocks)
            foundMatch = true
            break
          }

          currentHighlightBlocks = []
          continue
        }

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
        throw new Error('Highlight not found in Notion page. It may have been deleted or moved.')
      }

      // Update the matching blocks with new content
      // Update the first block and delete/add others as needed
      const firstBlock = matchingBlocks[0]
      const firstNewBlock = newBlocks[0]

      if (firstBlock.type === firstNewBlock?.type) {
        // Same type, update in place
        await notion.blocks.update({
          block_id: firstBlock.id,
          [firstBlock.type]: firstNewBlock[firstBlock.type],
        })
      } else {
        // Different type, delete and recreate
        await notion.blocks.delete({ block_id: firstBlock.id })
        if (firstNewBlock) {
          await notion.blocks.children.append({
            block_id: notionSettings.notion_page_id,
            children: [firstNewBlock],
          })
        }
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
            block_id: notionSettings.notion_page_id,
            children: [newBlocks[i]],
          })
        } catch (error) {
          console.warn(`Failed to append block:`, error)
        }
      }
    } else if (queueItem.operation_type === 'delete') {
      // For delete, use the text/html_content stored in the queue item to find the block
      const deleteText = (queueItem.html_content || queueItem.text || '').trim().toLowerCase()
      const deletePlainText = (queueItem.text || '').trim().toLowerCase()

      if (!deleteText && !deletePlainText) {
        throw new Error('Cannot delete highlight: no text content available to find in Notion')
      }

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
      
      // Normalize the delete text for comparison
      const normalizedDeleteText = normalizeText(deleteText || deletePlainText)
      const normalizedDeletePlainText = normalizeText(deletePlainText)

      // Find matching blocks (blocks that contain the text to delete)
      // Group blocks by empty line separators (like in the import logic)
      const matchingBlocks: any[] = []
      let currentHighlightBlocks: any[] = []
      let foundMatch = false
      let emptyLineBefore: any | null = null
      let emptyLineAfter: any | null = null

      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i]
        const isParagraph = block.type === 'paragraph'
        const isEmpty = isParagraph &&
          (!block.paragraph?.rich_text || block.paragraph.rich_text.length === 0)

        if (isEmpty && currentHighlightBlocks.length > 0) {
          // Check if this group of blocks matches the highlight to delete
          const combinedText = normalizeText(
            currentHighlightBlocks
              .map(getBlockText)
              .join(' ')
          )

          if (combinedText === normalizedDeleteText || 
              combinedText === normalizedDeletePlainText ||
              (normalizedDeletePlainText && (
                combinedText.includes(normalizedDeletePlainText) || 
                normalizedDeletePlainText.includes(combinedText)
              ))) {
            matchingBlocks.push(...currentHighlightBlocks)
            // The empty line after is the current block
            emptyLineAfter = block
            foundMatch = true
            break
          }

          // Reset for next group - the empty line before the next group is this one
          emptyLineBefore = block
          currentHighlightBlocks = []
          continue
        }

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

        if (combinedText === normalizedDeleteText || 
            combinedText === normalizedDeletePlainText ||
            (normalizedDeletePlainText && (
              combinedText.includes(normalizedDeletePlainText) || 
              normalizedDeletePlainText.includes(combinedText)
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
    
    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Get user's Notion settings
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

    // Get pending queue items for this user (limit to 10 at a time)
    // Include:
    // 1. Items with status 'pending' that haven't exceeded max retries
    // 2. Items with status 'failed' that are past their next_retry_at time
    const now = new Date().toISOString()
    const { data: queueItems, error: queueError } = await (supabase
      .from('notion_sync_queue') as any)
      .select('*')
      .eq('user_id', user.id)
      .or(`and(status.eq.pending,retry_count.lt.5),and(status.eq.failed,retry_count.lt.20,or(next_retry_at.is.null,next_retry_at.lte.${now}))`)
      .order('created_at', { ascending: true })
      .limit(10)

    if (queueError) throw queueError

    if (!queueItems || queueItems.length === 0) {
      return NextResponse.json({
        processed: 0,
        message: 'No pending items to process',
      })
    }

    // Mark items as processing
    const itemIds = queueItems.map((item: any) => item.id)
    await (supabase
      .from('notion_sync_queue') as any)
      .update({ status: 'processing' })
      .in('id', itemIds)

    // Process each item
    let processed = 0
    let failed = 0

    for (const item of queueItems) {
      const result = await processQueueItem(supabase, item, notionSettings)
      if (result.success) {
        processed++
      } else {
        failed++
      }
    }

    return NextResponse.json({
      processed,
      failed,
      total: queueItems.length,
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
