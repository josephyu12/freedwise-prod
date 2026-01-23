import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'

// Convert Notion rich text to HTML
function notionRichTextToHTML(richText: any[]): string {
  return richText.map((text: any) => {
    let content = text.plain_text || ''
    
    // Apply formatting
    if (text.annotations.bold) content = `<strong>${content}</strong>`
    if (text.annotations.italic) content = `<em>${content}</em>`
    if (text.annotations.underline) content = `<u>${content}</u>`
    if (text.annotations.strikethrough) content = `<s>${content}</s>`
    if (text.annotations.code) content = `<code>${content}</code>`
    
    // Handle links
    if (text.href) {
      content = `<a href="${text.href}">${content}</a>`
    }
    
    return content
  }).join('')
}

// Recursively fetch children blocks for a list item
async function fetchBlockChildren(notion: Client, blockId: string): Promise<any[]> {
  const children: any[] = []
  let cursor = undefined
  
  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
    })
    children.push(...response.results)
    cursor = response.next_cursor || undefined
  } while (cursor)
  
  return children
}

// Convert Notion blocks to HTML, preserving formatting and nested lists
async function blocksToHTML(blocks: any[], notion?: Client): Promise<string> {
  let html = ''
  let i = 0
  
  while (i < blocks.length) {
    const block = blocks[i] as any
    
    switch (block.type) {
      case 'paragraph':
        if (block.paragraph?.rich_text && block.paragraph.rich_text.length > 0) {
          html += `<p>${notionRichTextToHTML(block.paragraph.rich_text)}</p>`
        } else {
          html += '<p><br></p>' // Empty paragraph
        }
        i++
        break
      
      case 'heading_1':
        if (block.heading_1?.rich_text && block.heading_1.rich_text.length > 0) {
          html += `<h1>${notionRichTextToHTML(block.heading_1.rich_text)}</h1>`
        }
        i++
        break
      
      case 'heading_2':
        if (block.heading_2?.rich_text && block.heading_2.rich_text.length > 0) {
          html += `<h2>${notionRichTextToHTML(block.heading_2.rich_text)}</h2>`
        }
        i++
        break
      
      case 'heading_3':
        if (block.heading_3?.rich_text && block.heading_3.rich_text.length > 0) {
          html += `<h3>${notionRichTextToHTML(block.heading_3.rich_text)}</h3>`
        }
        i++
        break
      
      case 'bulleted_list_item':
        // Group consecutive bulleted list items at the same level
        const bulletedItems: any[] = []
        while (i < blocks.length && (blocks[i] as any).type === 'bulleted_list_item') {
          bulletedItems.push(blocks[i])
          i++
        }
        
        // Build nested list structure
        html += '<ul>'
        for (const item of bulletedItems) {
          const itemText = item.bulleted_list_item?.rich_text 
            ? notionRichTextToHTML(item.bulleted_list_item.rich_text)
            : ''
          
          // Check if this item has children (nested lists)
          // Try to fetch children - Notion API may not always set has_children correctly
          let nestedContent = ''
          if (notion && item.id) {
            try {
              const children = await fetchBlockChildren(notion, item.id)
              if (children && children.length > 0) {
                // Process children recursively - they might be nested list items
                nestedContent = await blocksToHTML(children, notion)
              }
            } catch (error: any) {
              // Silently fail - not all blocks have children or might not be accessible
              // This is expected for list items without nested content
            }
          }
          
          html += `<li>${itemText}${nestedContent}</li>`
        }
        html += '</ul>'
        break
      
      case 'numbered_list_item':
        // Group consecutive numbered list items at the same level
        const numberedItems: any[] = []
        while (i < blocks.length && (blocks[i] as any).type === 'numbered_list_item') {
          numberedItems.push(blocks[i])
          i++
        }
        
        // Build nested list structure
        html += '<ol>'
        for (const item of numberedItems) {
          const itemText = item.numbered_list_item?.rich_text 
            ? notionRichTextToHTML(item.numbered_list_item.rich_text)
            : ''
          
          // Check if this item has children (nested lists)
          // Try to fetch children - Notion API may not always set has_children correctly
          let nestedContent = ''
          if (notion && item.id) {
            try {
              const children = await fetchBlockChildren(notion, item.id)
              if (children && children.length > 0) {
                // Process children recursively - they might be nested list items
                nestedContent = await blocksToHTML(children, notion)
              }
            } catch (error: any) {
              // Silently fail - not all blocks have children or might not be accessible
              // This is expected for list items without nested content
            }
          }
          
          html += `<li>${itemText}${nestedContent}</li>`
        }
        html += '</ol>'
        break
      
      case 'quote':
        if (block.quote?.rich_text && block.quote.rich_text.length > 0) {
          html += `<blockquote>${notionRichTextToHTML(block.quote.rich_text)}</blockquote>`
        }
        i++
        break
      
      case 'code':
        if (block.code?.rich_text && block.code.rich_text.length > 0) {
          const code = block.code.rich_text.map((t: any) => t.plain_text).join('')
          html += `<pre><code>${code}</code></pre>`
        }
        i++
        break
      
      case 'divider':
        html += '<hr>'
        i++
        break
      
      case 'toggle':
        // Skip toggle blocks - don't include them in HTML
        // Also skip any children (they should be handled by the parent processing)
        i++
        break
      
      default:
        // For other block types, try to extract plain text
        if (block[block.type]?.rich_text) {
          html += `<p>${notionRichTextToHTML(block[block.type].rich_text)}</p>`
        }
        i++
    }
  }
  
  return html
}

// Extract plain text from blocks for text field
function blocksToText(blocks: any[]): string {
  return blocks
    .map((block: any) => {
      if (block[block.type]?.rich_text) {
        return block[block.type].rich_text.map((t: any) => t.plain_text).join('')
      }
      return ''
    })
    .filter((text: string) => text.length > 0)
    .join('\n')
}

export async function POST(request: NextRequest) {
  try {
    const { pageId, notionApiKey } = await request.json()
    
    if (!pageId || !notionApiKey) {
      return NextResponse.json(
        { error: 'Page ID and Notion API key are required' },
        { status: 400 }
      )
    }
    
    // Initialize Notion client
    const notion = new Client({
      auth: notionApiKey,
    })
    
    // Fetch page content with all nested children
    const blocks = []
    let cursor = undefined
    
    do {
      const response = await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
      })
      
      blocks.push(...response.results)
      cursor = response.next_cursor || undefined
    } while (cursor)
    
    // Process blocks and split by empty lines (consecutive empty paragraphs)
    // Skip toggle blocks entirely (their children are nested and won't appear in top-level blocks)
    const highlights: { text: string; html: string }[] = []
    let currentHighlightBlocks: any[] = []
    
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as any
      
      // Skip toggle blocks entirely - their nested children won't be in the top-level blocks array
      // Toggle children are nested and need to be fetched separately, so they won't appear here
      if (block.type === 'toggle') {
        continue
      }
      
      const isParagraph = block.type === 'paragraph'
      const isEmpty = isParagraph && 
        (!block.paragraph?.rich_text || block.paragraph.rich_text.length === 0)
      
      // If we hit an empty paragraph and we have content, it's a separator
      // Single empty paragraph = new highlight
      if (isEmpty && currentHighlightBlocks.length > 0) {
        // Save current highlight
        const html = await blocksToHTML(currentHighlightBlocks, notion)
        const text = blocksToText(currentHighlightBlocks)
        
        if (text.trim().length > 0) {
          highlights.push({ text: text.trim(), html: html.trim() })
        }
        
        // Reset for next highlight
        currentHighlightBlocks = []
        // Skip the empty block
        continue
      }
      
      // Add block to current highlight (unless it's an empty paragraph at the start)
      if (!isEmpty || currentHighlightBlocks.length > 0) {
        currentHighlightBlocks.push(block)
      }
    }
    
    // Don't forget the last highlight if there's content
    if (currentHighlightBlocks.length > 0) {
      const html = await blocksToHTML(currentHighlightBlocks, notion)
      const text = blocksToText(currentHighlightBlocks)
      
      if (text.trim().length > 0) {
        highlights.push({ text: text.trim(), html: html.trim() })
      }
    }
    
    // If no highlights found (maybe no empty lines), return everything as one highlight
    if (highlights.length === 0) {
      const html = await blocksToHTML(blocks, notion)
      const text = blocksToText(blocks)
      
      if (text.trim().length > 0) {
        highlights.push({ text: text.trim(), html: html.trim() })
      }
    }
    
    return NextResponse.json({ highlights })
  } catch (error: any) {
    console.error('Error importing from Notion:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to import from Notion' },
      { status: 500 }
    )
  }
}

