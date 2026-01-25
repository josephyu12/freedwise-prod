import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'
import { createClient } from '@/lib/supabase/server'

// Convert HTML to Notion rich text format (simplified version)
function htmlToNotionRichText(html: string): any[] {
  if (!html || html.trim() === '') {
    return []
  }

  // Simple HTML to text converter
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

  const richText: any[] = []
  const plainText = stripHtml(html)
  
  if (plainText) {
    // Check if the original HTML had bold/italic/underline
    const hasBold = /<strong|<b/i.test(html)
    const hasItalic = /<em|<i/i.test(html)
    const hasUnderline = /<u/i.test(html)
    const hasCode = /<code/i.test(html)
    
    // Extract links
    const linkRegex = /<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi
    let linkMatch
    const links: Array<{ href: string; text: string; start: number; end: number }> = []
    
    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const linkText = stripHtml(linkMatch[2])
      const linkStart = plainText.indexOf(linkText)
      if (linkStart !== -1) {
        links.push({
          href: linkMatch[1],
          text: linkText,
          start: linkStart,
          end: linkStart + linkText.length,
        })
      }
    }
    
    // Split text into segments (with links)
    let currentPos = 0
    const sortedLinks = links.sort((a, b) => a.start - b.start)
    
    for (const link of sortedLinks) {
      // Add text before link
      if (link.start > currentPos) {
        const beforeText = plainText.substring(currentPos, link.start)
        if (beforeText) {
          richText.push({
            type: 'text',
            text: { content: beforeText },
            annotations: {
              bold: hasBold,
              italic: hasItalic,
              strikethrough: false,
              underline: hasUnderline,
              code: hasCode,
              color: 'default',
            },
            plain_text: beforeText,
          })
        }
      }
      
      // Add link
      richText.push({
        type: 'text',
        text: { content: link.text, link: { url: link.href } },
        annotations: {
          bold: hasBold,
          italic: hasItalic,
          strikethrough: false,
          underline: hasUnderline,
          code: hasCode,
          color: 'default',
        },
        plain_text: link.text,
      })
      
      currentPos = link.end
    }
    
    // Add remaining text
    if (currentPos < plainText.length) {
      const remainingText = plainText.substring(currentPos)
      if (remainingText) {
        richText.push({
          type: 'text',
          text: { content: remainingText },
          annotations: {
            bold: hasBold,
            italic: hasItalic,
            strikethrough: false,
            underline: hasUnderline,
            code: hasCode,
            color: 'default',
          },
          plain_text: remainingText,
        })
      }
    }
    
    // If no links, add entire text as one segment
    if (richText.length === 0) {
      richText.push({
        type: 'text',
        text: { content: plainText },
        annotations: {
          bold: hasBold,
          italic: hasItalic,
          strikethrough: false,
          underline: hasUnderline,
          code: hasCode,
          color: 'default',
        },
        plain_text: plainText,
      })
    }
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

// Convert HTML to Notion blocks
function htmlToNotionBlocks(html: string): any[] {
  if (!html || html.trim() === '') {
    return [{
      type: 'paragraph',
      paragraph: { rich_text: [] },
    }]
  }

  const blocks: any[] = []
  
  // First, extract text that appears before lists (not wrapped in tags)
  // This handles cases like "Yogi Berra Bangers:\n<ul>..."
  const textBeforeLists: string[] = []
  const listStartRegex = /(<ul|<ol)/
  const listStartMatch = listStartRegex.exec(html)
  if (listStartMatch && listStartMatch.index > 0) {
    const textBefore = html.substring(0, listStartMatch.index).trim()
    if (textBefore && !textBefore.match(/<[^>]+>/)) {
      // Text before list that's not in any HTML tags
      const lines = textBefore.split(/\n/).map(l => l.trim()).filter(l => l.length > 0)
      textBeforeLists.push(...lines)
    }
  }
  
  // Extract list items
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
  
  // Add text that appeared before lists (at the beginning, before list items)
  if (textBeforeLists.length > 0) {
    for (const line of textBeforeLists) {
      const richText = htmlToNotionRichText(line)
      if (richText.length > 0) {
        blocks.unshift({
          type: 'paragraph',
          paragraph: { rich_text: richText },
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
    const code = remainingHtml.substring(preMatch.index, preMatch.index + preMatch[0].length)
      .replace(/<[^>]*>/g, '')
      .trim()
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
    remainingHtml = remainingHtml.replace(preMatch[0], '')
  }
  
  // Process paragraphs (what's left)
  const pRegex = /<p[^>]*>(.*?)<\/p>/gi
  let pMatch
  while ((pMatch = pRegex.exec(remainingHtml)) !== null) {
    const richText = htmlToNotionRichText(pMatch[1])
    if (richText.length > 0 || pMatch[1].trim() === '') {
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: richText },
      })
    }
  }
  
  // Remove processed <p> tags from remainingHtml
  remainingHtml = remainingHtml.replace(/<p[^>]*>.*?<\/p>/gi, '')
  
  // Process any remaining text that's not in tags
  // (Text before lists is already handled above, so this catches other cases)
  const textWithoutTags = remainingHtml
    .replace(/<[^>]*>/g, '') // Remove all remaining HTML tags
    .trim()
  
  if (textWithoutTags && !textBeforeLists.includes(textWithoutTags)) {
    const richText = htmlToNotionRichText(textWithoutTags)
    if (richText.length > 0) {
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: richText },
      })
    }
  }
  
  // If no blocks were created, create a paragraph with the remaining content
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

    const { text, htmlContent } = await request.json()

    if (!text) {
      return NextResponse.json(
        { error: 'Text is required' },
        { status: 400 }
      )
    }

    // Get user's Notion settings
    const { data: notionSettingsData, error: settingsError } = await supabase
      .from('user_notion_settings')
      .select('notion_api_key, notion_page_id, enabled')
      .eq('user_id', user.id)
      .eq('enabled', true)
      .maybeSingle()

    if (settingsError) {
      console.error('Error fetching Notion settings:', settingsError)
      return NextResponse.json(
        { error: 'Failed to fetch Notion settings' },
        { status: 500 }
      )
    }

    if (!notionSettingsData) {
      return NextResponse.json(
        { error: 'Notion integration not configured. Please set up your Notion credentials in settings.' },
        { status: 400 }
      )
    }

    const notionSettings = notionSettingsData as { notion_api_key: string; notion_page_id: string; enabled: boolean }
    const notionApiKey = notionSettings.notion_api_key
    const notionPageId = notionSettings.notion_page_id

    // Initialize Notion client
    const notion = new Client({
      auth: notionApiKey,
    })

    // Convert HTML to Notion blocks
    const blocks = htmlToNotionBlocks(htmlContent || text)

    if (blocks.length === 0) {
      return NextResponse.json(
        { error: 'Failed to convert content to Notion format' },
        { status: 400 }
      )
    }

    // Add an empty paragraph as separator (to mark end of this highlight)
    blocks.push({
      type: 'paragraph',
      paragraph: { rich_text: [] },
    })

    // Append blocks to Notion page
    await notion.blocks.children.append({
      block_id: notionPageId,
      children: blocks,
    })

    return NextResponse.json({
      message: 'Highlight added to Notion successfully',
      success: true,
    })
  } catch (error: any) {
    console.error('Error adding highlight to Notion:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to add highlight to Notion' },
      { status: 500 }
    )
  }
}

