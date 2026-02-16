import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { format } from 'date-fns'
import { Database } from '@/types/database'
import crypto from 'crypto'

// Verify the HMAC-signed widget token and extract the user ID
// Token format: userId.expiryTimestamp.signature
function verifyWidgetToken(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [userId, expiryStr, signature] = parts
  const expiryTimestamp = parseInt(expiryStr, 10)

  // Check if expired
  if (isNaN(expiryTimestamp) || Date.now() > expiryTimestamp) {
    return null
  }

  const payload = `${userId}.${expiryStr}`
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  // Timing-safe comparison
  if (signature.length !== expected.length) return null
  const sigBuf = Buffer.from(signature, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  if (sigBuf.length !== expBuf.length) return null
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null

  return userId
}

// GET: Single endpoint for the Scriptable widget
// Accepts a signed widget token, verifies it, fetches the next highlight
export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }

    const userId = verifyWidgetToken(token)

    if (!userId) {
      return NextResponse.json(
        { error: 'Invalid token', tokenExpired: true },
        { status: 401 }
      )
    }

    // Use service role client — safe because we verified the user via HMAC
    const supabase = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const today = format(new Date(), 'yyyy-MM-dd')

    // Get today's daily summary
    const { data: summaryData, error: summaryError } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('date', today)
      .eq('user_id', userId)
      .maybeSingle()

    if (summaryError) throw summaryError

    if (!summaryData) {
      return NextResponse.json({
        highlight: null,
        total: 0,
        reviewed: 0,
      })
    }

    const summary = summaryData as { id: string }

    // Get all highlights for the summary
    const { data: allHighlights, error: allError } = await supabase
      .from('daily_summary_highlights')
      .select('id, highlight_id, rating')
      .eq('daily_summary_id', summary.id)

    if (allError) throw allError

    const total = (allHighlights || []).length
    const reviewed = (allHighlights || []).filter(
      (h: any) => h.rating !== null
    ).length

    // Get unrated highlights
    const { data: unratedHighlights, error: nextError } = await supabase
      .from('daily_summary_highlights')
      .select(
        `
        id,
        highlight_id,
        highlight:highlights (
          id,
          text,
          html_content,
          source,
          author
        )
      `
      )
      .eq('daily_summary_id', summary.id)
      .is('rating', null)
      .order('id', { ascending: true })

    if (nextError) throw nextError

    if (!unratedHighlights || unratedHighlights.length === 0) {
      return NextResponse.json({
        highlight: null,
        total,
        reviewed,
        allDone: true,
      })
    }

    // Pick the shortest highlight by text length
    const shortest = (unratedHighlights as any[]).reduce(
      (shortest, current) => {
        const shortestLen = shortest.highlight?.text?.length || Infinity
        const currentLen = current.highlight?.text?.length || Infinity
        return currentLen < shortestLen ? current : shortest
      }
    )

    return NextResponse.json({
      highlight: {
        summaryHighlightId: shortest.id,
        highlightId: shortest.highlight_id,
        text: shortest.highlight?.text || '',
        htmlContent: shortest.highlight?.html_content || null,
        source: shortest.highlight?.source || null,
        author: shortest.highlight?.author || null,
      },
      total,
      reviewed,
      allDone: false,
    })
  } catch (error: any) {
    console.error('Widget API error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch highlight' },
      { status: 500 }
    )
  }
}
