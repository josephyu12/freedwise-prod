import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@notionhq/client'
import { createClient } from '@/lib/supabase/server'
import { htmlToNotionBlocks } from '@/lib/notionBlocks'

// (Block conversion lives in @/lib/notionBlocks)

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

