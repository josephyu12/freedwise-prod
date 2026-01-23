import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'
import { createClient } from '@/lib/supabase/server'

// Convert Notion rich text to HTML (same as in import route)
function notionRichTextToHTML(richText: any[]): string {
  return richText.map((text: any) => {
    let content = text.plain_text || ''
    
    if (text.annotations.bold) content = `<strong>${content}</strong>`
    if (text.annotations.italic) content = `<em>${content}</em>`
    if (text.annotations.underline) content = `<u>${content}</u>`
    if (text.annotations.strikethrough) content = `<s>${content}</s>`
    if (text.annotations.code) content = `<code>${content}</code>`
    
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
          html += '<p><br></p>'
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
        if (block[block.type]?.rich_text) {
          html += `<p>${notionRichTextToHTML(block[block.type].rich_text)}</p>`
        }
        i++
    }
  }
  
  return html
}

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

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    
    // Get authenticated user
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized - must be authenticated' },
        { status: 401 }
      )
    }
    
    // Get Notion credentials from environment variables
    const notionApiKey = process.env.NOTION_API_KEY
    const notionPageId = process.env.NOTION_PAGE_ID
    const cronSecret = request.headers.get('authorization')?.replace('Bearer ', '') || 
                      request.nextUrl.searchParams.get('secret')

    // Verify cron secret for security
    if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    if (!notionApiKey || !notionPageId) {
      return NextResponse.json(
        { error: 'Notion API key and Page ID must be set in environment variables' },
        { status: 400 }
      )
    }

    // Initialize Notion client
    const notion = new Client({
      auth: notionApiKey,
    })

    // Fetch page content
    const blocks = []
    let cursor = undefined

    do {
      const response = await notion.blocks.children.list({
        block_id: notionPageId,
        start_cursor: cursor,
      })

      blocks.push(...response.results)
      cursor = response.next_cursor || undefined
    } while (cursor)

    // Process blocks and split by empty lines
    // Skip toggle blocks entirely (their children are nested and won't appear in top-level blocks)
    const highlights: { text: string; html: string }[] = []
    let currentHighlightBlocks: any[] = []

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as any
      
      // Skip toggle blocks entirely - their nested children won't be in the top-level blocks array
      if (block.type === 'toggle') {
        continue
      }
      
      const isParagraph = block.type === 'paragraph'
      const isEmpty = isParagraph &&
        (!block.paragraph?.rich_text || block.paragraph.rich_text.length === 0)

      if (isEmpty && currentHighlightBlocks.length > 0) {
        const html = await blocksToHTML(currentHighlightBlocks, notion)
        const text = blocksToText(currentHighlightBlocks)

        if (text.trim().length > 0) {
          highlights.push({ text: text.trim(), html: html.trim() })
        }

        currentHighlightBlocks = []
        continue
      }

      if (!isEmpty || currentHighlightBlocks.length > 0) {
        currentHighlightBlocks.push(block)
      }
    }

    if (currentHighlightBlocks.length > 0) {
      const html = await blocksToHTML(currentHighlightBlocks, notion)
      const text = blocksToText(currentHighlightBlocks)

      if (text.trim().length > 0) {
        highlights.push({ text: text.trim(), html: html.trim() })
      }
    }

    if (highlights.length === 0) {
      return NextResponse.json({
        message: 'No highlights found',
        imported: 0,
        skipped: 0,
      })
    }

    // Get ALL existing highlights (including archived) to check for duplicates and updates
    // This ensures we don't create duplicates even if highlights are archived
    // Paginate through all highlights to avoid Supabase's default limit
    const existingHighlights: any[] = []
    let fetchCursor = 0
    const pageSize = 1000
    
    while (true) {
      const { data: batch, error: fetchError } = await supabase
        .from('highlights')
        .select('id, text, html_content, archived')
        .eq('user_id', user.id) // Only get user's own highlights
        // Note: We intentionally include archived highlights to avoid duplicates
        .range(fetchCursor, fetchCursor + pageSize - 1)
      
      if (fetchError) throw fetchError
      
      if (!batch || batch.length === 0) break
      
      existingHighlights.push(...batch)
      
      // If we got fewer than pageSize, we've reached the end
      if (batch.length < pageSize) break
      
      fetchCursor += pageSize
    }

    // Helper function to normalize text for comparison
    const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')
    
    // Helper function to calculate similarity (simple Levenshtein-like approach)
    const calculateSimilarity = (str1: string, str2: string): number => {
      const s1 = normalize(str1)
      const s2 = normalize(str2)
      if (s1 === s2) return 1.0
      if (s1.length === 0 || s2.length === 0) return 0.0
      
      // Simple similarity: check if one contains the other or vice versa
      if (s1.includes(s2) || s2.includes(s1)) {
        const longer = s1.length > s2.length ? s1 : s2
        const shorter = s1.length > s2.length ? s2 : s1
        return shorter.length / longer.length
      }
      
      // Check word overlap
      const words1 = s1.split(' ')
      const words2 = s2.split(' ')
      const commonWords = words1.filter(w => words2.includes(w))
      return (commonWords.length * 2) / (words1.length + words2.length)
    }

    const newHighlights: typeof highlights = []
    const updatedHighlights: Array<{ id: string; text: string; html: string }> = []
    let skipped = 0

    for (const highlight of highlights) {
      const textNormalized = normalize(highlight.text)
      const htmlNormalized = normalize(highlight.html)
      
      // Try to find a matching highlight
      let matched = false
      let bestMatch: { id: string; similarity: number } | null = null
      
      for (const existing of existingHighlights || []) {
        const existingText = normalize(existing.text || '')
        const existingHtml = normalize(existing.html_content || '')
        
        // Check exact match first
        if (existingText === textNormalized || existingHtml === htmlNormalized ||
            existingText === htmlNormalized || existingHtml === textNormalized) {
          // Exact match - check if content has changed
          const currentText = highlight.text.trim()
          const currentHtml = highlight.html.trim()
          const dbText = existing.text?.trim() || ''
          const dbHtml = existing.html_content?.trim() || ''
          
          if (currentText !== dbText || currentHtml !== dbHtml) {
            // Content has changed, update it
            updatedHighlights.push({
              id: existing.id,
              text: currentText,
              html: currentHtml,
            })
          } else {
            skipped++
          }
          matched = true
          break
        }
        
        // Check similarity for fuzzy matching (if text is similar enough, consider it the same)
        const textSimilarity = calculateSimilarity(highlight.text, existing.text || '')
        const htmlSimilarity = existing.html_content 
          ? calculateSimilarity(highlight.html, existing.html_content)
          : 0
        
        const maxSimilarity = Math.max(textSimilarity, htmlSimilarity)
        
        // If similarity is high enough (>= 0.8), consider it a match
        if (maxSimilarity >= 0.8) {
          if (!bestMatch || maxSimilarity > bestMatch.similarity) {
            bestMatch = { id: existing.id, similarity: maxSimilarity }
          }
        }
      }
      
      // If we found a fuzzy match, update it
      if (!matched && bestMatch) {
        updatedHighlights.push({
          id: bestMatch.id,
          text: highlight.text.trim(),
          html: highlight.html.trim(),
        })
        matched = true
      }
      
      // If no match found, it's a new highlight
      if (!matched) {
        newHighlights.push(highlight)
      }
    }

    // Update existing highlights that changed
    let updatedCount = 0
    for (const update of updatedHighlights) {
      const { error: updateError } = await (supabase
        .from('highlights') as any)
        .update({
          text: update.text,
          html_content: update.html || null,
        })
        .eq('id', update.id)
        .eq('user_id', user.id) // Ensure user can only update their own highlights
      
      if (!updateError) {
        updatedCount++
      } else {
        console.warn(`Failed to update highlight ${update.id}:`, updateError)
      }
    }

    // Import new highlights
    let importedCount = 0
    if (newHighlights.length > 0) {
      const highlightsToInsert = newHighlights.map((highlight) => ({
        text: highlight.text.trim(),
        html_content: highlight.html.trim() || null,
        source: process.env.NOTION_SOURCE || null,
        author: process.env.NOTION_AUTHOR || null,
        resurface_count: 0,
        average_rating: 0,
        rating_count: 0,
        archived: false,
        user_id: user.id, // Required for RLS policy
      }))

      const { error: insertError } = await (supabase
        .from('highlights') as any)
        .insert(highlightsToInsert)

      if (insertError) throw insertError
      importedCount = newHighlights.length
    }

    // Redistribute daily assignments if new highlights were imported
    if (importedCount > 0) {
      try {
        const now = new Date()
        const year = now.getFullYear()
        const month = now.getMonth() + 1
        const dayOfMonth = now.getDate()
        const daysInMonth = new Date(year, month, 0).getDate()

        // Don't redistribute if it's the last day of the month
        if (dayOfMonth !== daysInMonth) {
          const monthYear = `${year}-${String(month).padStart(2, '0')}`

          // Get all unarchived highlights for this user
          const { data: allHighlightsData, error: highlightsError } = await supabase
            .from('highlights')
            .select('id, text, html_content')
            .eq('user_id', user.id)
            .eq('archived', false)

          if (!highlightsError && allHighlightsData) {
            // Get highlights that have already been reviewed for this month
            const { data: reviewedHighlightsData } = await supabase
              .from('highlight_months_reviewed')
              .select('highlight_id')
              .eq('month_year', monthYear)

            const reviewedHighlightIds = new Set(
              (reviewedHighlightsData || []).map((r: any) => r.highlight_id)
            )

            // Filter out highlights that have already been reviewed this month
            const allHighlights = (allHighlightsData as Array<{
              id: string
              text: string
              html_content: string | null
            }>).filter((h) => !reviewedHighlightIds.has(h.id))

            if (allHighlights.length > 0) {
              // Calculate score (character count) for each highlight
              const highlightsWithScore = allHighlights.map((h) => {
                const content = h.html_content || h.text || ''
                const plainText = content.replace(/<[^>]*>/g, '')
                const score = plainText.length
                return { id: h.id, text: h.text, html_content: h.html_content, score }
              })

              // Seeded shuffle function for deterministic randomization
              const seededShuffle = <T,>(array: T[], seed: number): T[] => {
                const shuffled = [...array]
                let random = seed
                const seededRandom = () => {
                  random = (random * 9301 + 49297) % 233280
                  return random / 233280
                }
                for (let i = shuffled.length - 1; i > 0; i--) {
                  const j = Math.floor(seededRandom() * (i + 1))
                  ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
                }
                return shuffled
              }

              const seed = year * 100 + month
              const shuffledHighlights = seededShuffle(highlightsWithScore, seed)
              const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)
              const totalScore = highlightsWithScore.reduce((sum, h) => sum + h.score, 0)
              const targetScorePerDay = totalScore / daysInMonth

              const days: Array<{
                day: number
                highlights: typeof highlightsWithScore
                totalScore: number
              }> = Array.from({ length: daysInMonth }, (_, i) => ({
                day: i + 1,
                highlights: [],
                totalScore: 0,
              }))

              for (const highlight of sortedHighlights) {
                let minDayIndex = 0
                let minScore = days[0].totalScore
                for (let i = 1; i < days.length; i++) {
                  if (days[i].totalScore < minScore) {
                    minScore = days[i].totalScore
                    minDayIndex = i
                  }
                }
                days[minDayIndex].highlights.push(highlight)
                days[minDayIndex].totalScore += highlight.score
              }

              // Delete existing assignments for this month
              const startDate = `${year}-${String(month).padStart(2, '0')}-01`
              const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`

              const { data: existingSummaries } = await supabase
                .from('daily_summaries')
                .select('id')
                .eq('user_id', user.id)
                .gte('date', startDate)
                .lte('date', endDate)

              if (existingSummaries && existingSummaries.length > 0) {
                const summaryIds = existingSummaries.map((s: any) => s.id)
                await supabase.from('daily_summary_highlights').delete().in('daily_summary_id', summaryIds)
                await supabase.from('daily_summaries').delete().in('id', summaryIds)
              }

              // Recreate assignments
              for (const assignment of days) {
                if (assignment.highlights.length === 0) continue
                const date = `${year}-${String(month).padStart(2, '0')}-${String(assignment.day).padStart(2, '0')}`
                const { data: summaryData } = await (supabase
                  .from('daily_summaries') as any)
                  .insert([{ date, user_id: user.id }])
                  .select()
                  .single()
                if (summaryData) {
                  const summaryHighlights = assignment.highlights.map((h) => ({
                    daily_summary_id: summaryData.id,
                    highlight_id: h.id,
                  }))
                  await (supabase.from('daily_summary_highlights') as any).insert(summaryHighlights)
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn('Error redistributing daily assignments:', error)
        // Don't fail the import if redistribution fails
      }
    }

    return NextResponse.json({
      message: 'Sync completed successfully',
      imported: importedCount,
      updated: updatedCount,
      skipped: skipped,
      total: highlights.length,
    })
  } catch (error: any) {
    console.error('Error in auto-import:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to import from Notion' },
      { status: 500 }
    )
  }
}

