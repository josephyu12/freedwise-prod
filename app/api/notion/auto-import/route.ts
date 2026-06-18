import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'
import { createClient } from '@/lib/supabase/server'
import { normalizeForBlockCompare } from '@/lib/notionBlocks'
import { getCycleForDate, cycleSeed, getUserReviewSettings } from '@/lib/cycle'
import { packIntoDates } from '@/lib/binPack'

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

// Extract plain text from HTML by stripping tags
// This ensures text field matches the HTML content exactly
function htmlToPlainText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, '') // Strip HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
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
        const text = htmlToPlainText(html)

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
      const text = htmlToPlainText(html)

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

    const newHighlights: typeof highlights = []
    const updatedHighlights: Array<{ id: string; text: string; html: string }> = []
    let skipped = 0

    for (const highlight of highlights) {
      const htmlNormalized = normalizeForBlockCompare(highlight.html)

      // Try to find an exact match
      let matched = false

      for (const existing of existingHighlights || []) {
        const existingHtml = normalizeForBlockCompare(existing.html_content || '')

        // Check for exact match on normalized HTML
        // Since text is now derived from HTML, we only need to compare HTML
        if (existingHtml === htmlNormalized) {
          // Check if raw content has changed (e.g., formatting changes)
          const currentText = highlight.text.trim()
          const currentHtml = highlight.html.trim()
          const dbText = existing.text?.trim() || ''
          const dbHtml = existing.html_content?.trim() || ''

          const textDiffers = currentText !== dbText
          const htmlDiffers = currentHtml !== dbHtml

          if (textDiffers || htmlDiffers) {
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
      }

      // If no match found, it's a new highlight
      if (!matched) {
        newHighlights.push(highlight)
      }
    }

    // Update existing highlights that changed.
    // NOTE: each of these UPDATEs trips the enqueue_notion_sync DB trigger,
    // which enqueues an 'update' op. The content came FROM Notion, so the
    // resulting sync is an idempotent no-op write back to the same page —
    // harmless, but it does add queue churn if this route is ever scheduled.
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
        // Read FROM Notion — already on the page. Flag so the
        // enqueue_notion_sync DB trigger does not enqueue a duplicate 'add'.
        imported_from_notion: true,
      }))

      const { error: insertError } = await (supabase
        .from('highlights') as any)
        .insert(highlightsToInsert)

      if (insertError) throw insertError
      importedCount = newHighlights.length
    }

    // Redistribute daily assignments if new highlights were imported.
    // Re-tile the current review cycle: preserve rated days, re-pack all
    // not-yet-reviewed highlights across the cycle's days. No-op when daily
    // review is off for the user.
    if (importedCount > 0) {
      try {
        const { freq, enabled } = await getUserReviewSettings(supabase, user.id)
        if (enabled) {
          const now = new Date()
          const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
          const cycle = getCycleForDate(todayIso, freq)

          const { data: allHighlightsData } = await supabase
            .from('highlights')
            .select('id, text, html_content')
            .eq('user_id', user.id)
            .eq('archived', false)

          if (allHighlightsData) {
            const { data: reviewedData } = await supabase
              .from('highlight_months_reviewed')
              .select('highlight_id')
              .eq('month_year', cycle.key)
            const reviewedIds = new Set((reviewedData || []).map((r: any) => r.highlight_id))

            const { data: existingSummaries } = await supabase
              .from('daily_summaries')
              .select('id, date')
              .eq('user_id', user.id)
              .gte('date', cycle.startDate)
              .lte('date', cycle.endDate)
            const typedSummaries = (existingSummaries || []) as Array<{ id: string; date: string }>

            const ratedIds = new Set<string>()
            const nonRatedAssignmentIds: string[] = []
            if (typedSummaries.length > 0) {
              const summaryIds = typedSummaries.map((s) => s.id)
              const { data: assignments } = await supabase
                .from('daily_summary_highlights')
                .select('id, highlight_id, rating')
                .in('daily_summary_id', summaryIds)
              for (const a of (assignments || []) as Array<{ id: string; highlight_id: string; rating: number | null }>) {
                if (a.rating !== null) ratedIds.add(a.highlight_id)
                else nonRatedAssignmentIds.push(a.id)
              }
              // Drop non-rated assignments so they can be re-packed across the cycle.
              if (nonRatedAssignmentIds.length > 0) {
                await supabase.from('daily_summary_highlights').delete().in('id', nonRatedAssignmentIds)
              }
            }

            const toAssign = (allHighlightsData as Array<{ id: string; text: string; html_content: string | null }>)
              .filter((h) => !reviewedIds.has(h.id) && !ratedIds.has(h.id))
              .map((h) => {
                const content = h.html_content || h.text || ''
                return { id: h.id, text: h.text, html_content: h.html_content, score: content.replace(/<[^>]*>/g, '').length }
              })

            if (toAssign.length > 0) {
              const buckets = packIntoDates(toAssign, cycle.dates, cycleSeed(cycle))
              for (const bucket of buckets) {
                if (bucket.highlights.length === 0) continue
                let summaryId: string | null = typedSummaries.find((s) => s.date === bucket.date)?.id ?? null
                if (!summaryId) {
                  const { data: summaryData } = await (supabase
                    .from('daily_summaries') as any)
                    .insert([{ date: bucket.date, user_id: user.id }])
                    .select()
                    .single()
                  if (summaryData) summaryId = summaryData.id
                }
                if (summaryId) {
                  await (supabase.from('daily_summary_highlights') as any).upsert(
                    bucket.highlights.map((h) => ({ daily_summary_id: summaryId, highlight_id: h.id })),
                    { onConflict: 'daily_summary_id,highlight_id', ignoreDuplicates: true }
                  )
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

