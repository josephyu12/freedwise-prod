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
  
  // Process content sequentially to maintain order
  // Find all major content blocks with their positions
  interface ContentBlock {
    index: number
    type: 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre' | 'p' | 'text'
    content: string
    fullMatch: string
  }
  
  const contentBlocks: ContentBlock[] = []
  
  // Find all lists with their positions
  const ulRegex = /<ul[^>]*>(.*?)<\/ul>/gis
  let ulMatch
  while ((ulMatch = ulRegex.exec(html)) !== null) {
    contentBlocks.push({
      index: ulMatch.index,
      type: 'ul',
      content: ulMatch[1],
      fullMatch: ulMatch[0],
    })
  }
  
  const olRegex = /<ol[^>]*>(.*?)<\/ol>/gis
  let olMatch
  while ((olMatch = olRegex.exec(html)) !== null) {
    contentBlocks.push({
      index: olMatch.index,
      type: 'ol',
      content: olMatch[1],
      fullMatch: olMatch[0],
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
        const liRegex = /<li[^>]*>(.*?)<\/li>/gis
        let liMatch
        while ((liMatch = liRegex.exec(block.content)) !== null) {
          const richText = htmlToNotionRichText(liMatch[1])
          if (richText.length > 0) {
            blocks.push({
              type: 'bulleted_list_item',
              bulleted_list_item: { rich_text: richText },
            })
          }
        }
        break
      }
      case 'ol': {
        const liRegex = /<li[^>]*>(.*?)<\/li>/gis
        let liMatch
        while ((liMatch = liRegex.exec(block.content)) !== null) {
          const richText = htmlToNotionRichText(liMatch[1])
          if (richText.length > 0) {
            blocks.push({
              type: 'numbered_list_item',
              numbered_list_item: { rich_text: richText },
            })
          }
        }
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

