import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * GET /api/daily/prepare-next-month
 * This endpoint is called by a cron job to prepare next month's assignments
 * It should be called a week before the month begins
 */
export async function GET(request: NextRequest) {
  try {
    // Check for cron secret to prevent unauthorized access
    // Vercel cron jobs can be authenticated via authorization header or x-vercel-cron header
    const authHeader = request.headers.get('authorization')
    const vercelCronHeader = request.headers.get('x-vercel-cron')
    
    // Allow if it's a Vercel cron job (has x-vercel-cron header) OR has correct CRON_SECRET
    const isVercelCron = vercelCronHeader === '1'
    const hasValidSecret = process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`
    
    if (!isVercelCron && !hasValidSecret) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Use service role client to bypass RLS and access all users
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not set')
      return NextResponse.json(
        { error: 'Service role key not configured' },
        { status: 500 }
      )
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    // Calculate next month
    const now = new Date()
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const year = nextMonth.getFullYear()
    const month = nextMonth.getMonth() + 1
    const daysInMonth = new Date(year, month, 0).getDate()
    const monthYear = `${year}-${String(month).padStart(2, '0')}`

    console.log(`Preparing assignments for ${monthYear}`)

    // Get all unique user IDs from highlights table
    const { data: userHighlights, error: usersError } = await supabase
      .from('highlights')
      .select('user_id')
      .eq('archived', false)

    if (usersError) throw usersError

    // Get unique user IDs
    const userIds = Array.from(new Set((userHighlights || []).map((h: any) => h.user_id)))
    
    console.log(`Found ${userIds.length} users with highlights`)

    const results = {
      totalUsers: userIds.length,
      successful: 0,
      failed: 0,
      errors: [] as string[],
    }

    // Prepare assignments for each user
    for (const userId of userIds) {
      try {
        // Get all unarchived highlights for this user
        const { data: allHighlightsData, error: highlightsError } = await supabase
          .from('highlights')
          .select('id, text, html_content')
          .eq('user_id', userId)
          .eq('archived', false)

        if (highlightsError) throw highlightsError

        // Get highlights that have already been reviewed for next month
        const { data: reviewedHighlightsData, error: reviewedError } = await supabase
          .from('highlight_months_reviewed')
          .select('highlight_id')
          .eq('month_year', monthYear)

        if (reviewedError) throw reviewedError

        const reviewedHighlightIds = new Set(
          (reviewedHighlightsData || []).map((r: any) => r.highlight_id)
        )

        // Filter out highlights that have already been reviewed for next month
        const allHighlights = ((allHighlightsData || []) as Array<{
          id: string
          text: string
          html_content: string | null
        }>).filter((h) => !reviewedHighlightIds.has(h.id))

        if (allHighlights.length === 0) {
          console.log(`No highlights to assign for user ${userId}`)
          continue
        }

        // Calculate score (character count) for each highlight
        const highlightsWithScore = allHighlights.map((h) => {
          const content = h.html_content || h.text || ''
          const plainText = content.replace(/<[^>]*>/g, '')
          const score = plainText.length

          return {
            id: h.id,
            text: h.text,
            html_content: h.html_content,
            score,
          }
        })

        // Seeded shuffle function (same as in assign route)
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

        // Assign highlights to days
        const seed = year * 100 + month
        const shuffledHighlights = seededShuffle(highlightsWithScore, seed)
        const sortedHighlights = [...shuffledHighlights].sort((a, b) => b.score - a.score)

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

        // Check for existing assignments for next month
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`
        const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`

        const { data: existingSummaries, error: existingError } = await supabase
          .from('daily_summaries')
          .select('id')
          .eq('user_id', userId)
          .gte('date', startDate)
          .lte('date', endDate)

        if (existingError) throw existingError

        // Only create assignments if they don't already exist
        if (existingSummaries && existingSummaries.length > 0) {
          console.log(`Assignments already exist for user ${userId} for ${monthYear}, skipping`)
          results.successful++
          continue
        }

        // Create daily summaries and assignments
        for (const assignment of days) {
          if (assignment.highlights.length === 0) continue

          const date = `${year}-${String(month).padStart(2, '0')}-${String(assignment.day).padStart(2, '0')}`

          // Create daily summary
          const { data: summaryData, error: summaryError } = await supabase
            .from('daily_summaries')
            .insert([{ date, user_id: userId }])
            .select()
            .single()

          if (summaryError) throw summaryError

          // Link highlights to summary
          const summaryHighlights = assignment.highlights.map((h) => ({
            daily_summary_id: summaryData.id,
            highlight_id: h.id,
          }))

          const { error: linkError } = await supabase
            .from('daily_summary_highlights')
            .insert(summaryHighlights)

          if (linkError) throw linkError
        }

        results.successful++
        console.log(`Successfully prepared assignments for user ${userId}`)
      } catch (error: any) {
        results.failed++
        const errorMsg = `User ${userId}: ${error.message || 'Unknown error'}`
        results.errors.push(errorMsg)
        console.error(`Error preparing assignments for user ${userId}:`, error)
      }
    }

    return NextResponse.json({
      message: `Prepared assignments for ${monthYear}`,
      year,
      month,
      results,
    })
  } catch (error: any) {
    console.error('Error preparing next month assignments:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to prepare assignments' },
      { status: 500 }
    )
  }
}

