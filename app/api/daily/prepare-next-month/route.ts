import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * GET /api/daily/prepare-next-month
 * This endpoint is called by a cron job to prepare next month's assignments
 * It should be called a week before the month begins
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now()
  console.log('[PREPARE-NEXT-MONTH] Starting cron job execution')
  
  try {
    // Log all headers for debugging
    const allHeaders: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      allHeaders[key] = value
    })
    console.log('[PREPARE-NEXT-MONTH] All headers:', JSON.stringify(allHeaders, null, 2))
    
    // Check for cron secret to prevent unauthorized access
    // Vercel cron jobs can be authenticated via authorization header or x-vercel-cron header
    const authHeader = request.headers.get('authorization')
    const vercelCronHeader = request.headers.get('x-vercel-cron')
    const vercelSignature = request.headers.get('x-vercel-signature')
    const userAgent = request.headers.get('user-agent')
    const testUserId = request.nextUrl.searchParams.get('userId') // Allow testing specific user
    const secretParam = request.nextUrl.searchParams.get('secret')
    
    console.log('[PREPARE-NEXT-MONTH] Auth check:', {
      hasAuthHeader: !!authHeader,
      hasVercelCron: vercelCronHeader === '1',
      vercelCronValue: vercelCronHeader,
      hasVercelSignature: !!vercelSignature,
      userAgent: userAgent,
      hasTestUserId: !!testUserId,
      hasCronSecret: !!process.env.CRON_SECRET,
      hasSecretParam: !!secretParam,
    })
    
    // Allow if it's a Vercel cron job (has x-vercel-cron header) OR has correct CRON_SECRET
    // Also check for Vercel-specific headers or user-agent
    const isVercelCron = vercelCronHeader === '1' || 
                        vercelSignature !== null ||
                        (userAgent && userAgent.includes('vercel'))
    
    const hasValidSecret = process.env.CRON_SECRET && (
      authHeader === `Bearer ${process.env.CRON_SECRET}` || 
      secretParam === process.env.CRON_SECRET
    )
    
    // For manual testing: If CRON_SECRET is not set, we can allow if service role key exists
    // This is less secure but allows testing. In production, always set CRON_SECRET.
    // When Vercel runs it automatically, it should have x-vercel-cron header
    const hasServiceRoleKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY
    const isProduction = process.env.NODE_ENV === 'production'
    
    // Allow if:
    // 1. It's a Vercel cron (has x-vercel-cron header), OR
    // 2. Has valid CRON_SECRET, OR
    // 3. (Less secure) Service role key exists and we're not in strict production mode
    const shouldAllow = isVercelCron || hasValidSecret || (hasServiceRoleKey && !isProduction)
    
    if (!shouldAllow) {
      console.error('[PREPARE-NEXT-MONTH] Unauthorized access attempt', {
        isVercelCron,
        hasValidSecret,
        hasServiceRoleKey,
        isProduction,
        hint: 'Set CRON_SECRET environment variable and use it in the request',
      })
      return NextResponse.json(
        { 
          error: 'Unauthorized', 
          details: 'Missing valid cron authentication',
          hint: 'To test manually, add ?secret=YOUR_CRON_SECRET to the URL, or set CRON_SECRET in Vercel and use Authorization: Bearer YOUR_CRON_SECRET header',
          headers: Object.keys(allHeaders),
        },
        { status: 401 }
      )
    }
    
    if (!hasValidSecret && !isVercelCron) {
      console.warn('[PREPARE-NEXT-MONTH] Running without CRON_SECRET validation (using service role key only). Set CRON_SECRET for better security.')
    }

    // Use service role client to bypass RLS and access all users
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[PREPARE-NEXT-MONTH] SUPABASE_SERVICE_ROLE_KEY is not set')
      return NextResponse.json(
        { error: 'Service role key not configured' },
        { status: 500 }
      )
    }

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      console.error('[PREPARE-NEXT-MONTH] NEXT_PUBLIC_SUPABASE_URL is not set')
      return NextResponse.json(
        { error: 'Supabase URL not configured' },
        { status: 500 }
      )
    }

    console.log('[PREPARE-NEXT-MONTH] Environment check passed')

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

    // Test the service role client by trying to query highlights
    console.log('[PREPARE-NEXT-MONTH] Testing service role client...')
    const { data: testData, error: testError } = await supabase
      .from('highlights')
      .select('id')
      .limit(1)

    if (testError) {
      console.error('[PREPARE-NEXT-MONTH] Service role client test failed:', testError)
      return NextResponse.json(
        { 
          error: 'Service role client not working',
          details: testError.message,
          hint: 'Check that SUPABASE_SERVICE_ROLE_KEY is correct and has proper permissions'
        },
        { status: 500 }
      )
    }

    console.log('[PREPARE-NEXT-MONTH] Service role client test passed')

    // Calculate next month
    const now = new Date()
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const year = nextMonth.getFullYear()
    const month = nextMonth.getMonth() + 1
    const daysInMonth = new Date(year, month, 0).getDate()
    const monthYear = `${year}-${String(month).padStart(2, '0')}`

    console.log(`[PREPARE-NEXT-MONTH] Preparing assignments for ${monthYear}`)

    // Get all unique user IDs from highlights table
    console.log('[PREPARE-NEXT-MONTH] Fetching user IDs from highlights table...')
    const { data: userHighlights, error: usersError } = await supabase
      .from('highlights')
      .select('user_id')
      .eq('archived', false)

    if (usersError) {
      console.error('[PREPARE-NEXT-MONTH] Error fetching user highlights:', usersError)
      throw usersError
    }

    console.log(`[PREPARE-NEXT-MONTH] Raw highlights query returned ${userHighlights?.length || 0} rows`)

    // Get unique user IDs
    let userIds = Array.from(new Set((userHighlights || []).map((h: any) => h.user_id)))
    
    // If testing for a specific user, filter to just that user
    if (testUserId) {
      console.log(`[PREPARE-NEXT-MONTH] TEST MODE: Filtering to user ${testUserId}`)
      if (userIds.includes(testUserId)) {
        userIds = [testUserId]
      } else {
        console.warn(`[PREPARE-NEXT-MONTH] Test user ${testUserId} not found in highlights, will try anyway`)
        userIds = [testUserId]
      }
    }
    
    if (userIds.length === 0) {
      console.warn('[PREPARE-NEXT-MONTH] No users found with highlights')
      return NextResponse.json({
        message: `No users found with highlights for ${monthYear}`,
        year,
        month,
        results: {
          totalUsers: 0,
          successful: 0,
          failed: 0,
          errors: [],
        },
        hint: 'Make sure you have highlights in the database and the service role key has proper permissions'
      })
    }
    
    console.log(`[PREPARE-NEXT-MONTH] Found ${userIds.length} user(s) to process:`, userIds)

    const results = {
      totalUsers: userIds.length,
      successful: 0,
      failed: 0,
      errors: [] as string[],
    }

    // Prepare assignments for each user
    for (const userId of userIds) {
      const userStartTime = Date.now()
      console.log(`[PREPARE-NEXT-MONTH] Processing user ${userId}...`)
      
      try {
        // Get all unarchived highlights for this user
        console.log(`[PREPARE-NEXT-MONTH] Fetching highlights for user ${userId}...`)
        const { data: allHighlightsData, error: highlightsError } = await supabase
          .from('highlights')
          .select('id, text, html_content')
          .eq('user_id', userId)
          .eq('archived', false)

        if (highlightsError) {
          console.error(`[PREPARE-NEXT-MONTH] Error fetching highlights for user ${userId}:`, highlightsError)
          throw highlightsError
        }

        console.log(`[PREPARE-NEXT-MONTH] Found ${allHighlightsData?.length || 0} highlights for user ${userId}`)

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
          console.log(`[PREPARE-NEXT-MONTH] No highlights to assign for user ${userId} (all reviewed or no highlights)`)
          results.successful++
          continue
        }

        console.log(`[PREPARE-NEXT-MONTH] Processing ${allHighlights.length} highlights for user ${userId}`)

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
          console.log(`[PREPARE-NEXT-MONTH] Assignments already exist for user ${userId} for ${monthYear} (${existingSummaries.length} summaries), skipping`)
          results.successful++
          continue
        }

        console.log(`[PREPARE-NEXT-MONTH] Creating ${days.filter(d => d.highlights.length > 0).length} daily summaries for user ${userId}`)

        // Create daily summaries and assignments
        let summariesCreated = 0
        let highlightsAssigned = 0
        
        for (const assignment of days) {
          if (assignment.highlights.length === 0) continue

          const date = `${year}-${String(month).padStart(2, '0')}-${String(assignment.day).padStart(2, '0')}`

          // Create daily summary
          const { data: summaryData, error: summaryError } = await supabase
            .from('daily_summaries')
            .insert([{ date, user_id: userId }])
            .select()
            .single()

          if (summaryError) {
            console.error(`[PREPARE-NEXT-MONTH] Error creating summary for user ${userId}, date ${date}:`, summaryError)
            throw summaryError
          }

          // Link highlights to summary
          const summaryHighlights = assignment.highlights.map((h) => ({
            daily_summary_id: summaryData.id,
            highlight_id: h.id,
          }))

          const { error: linkError } = await supabase
            .from('daily_summary_highlights')
            .insert(summaryHighlights)

          if (linkError) {
            console.error(`[PREPARE-NEXT-MONTH] Error linking highlights for user ${userId}, date ${date}:`, linkError)
            throw linkError
          }

          summariesCreated++
          highlightsAssigned += assignment.highlights.length
        }

        results.successful++
        const userDuration = Date.now() - userStartTime
        console.log(`[PREPARE-NEXT-MONTH] Successfully prepared assignments for user ${userId}: ${summariesCreated} summaries, ${highlightsAssigned} highlights (took ${userDuration}ms)`)
      } catch (error: any) {
        results.failed++
        const errorMsg = `User ${userId}: ${error.message || 'Unknown error'}`
        results.errors.push(errorMsg)
        const userDuration = Date.now() - userStartTime
        console.error(`[PREPARE-NEXT-MONTH] Error preparing assignments for user ${userId} (took ${userDuration}ms):`, error)
        console.error(`[PREPARE-NEXT-MONTH] Error stack:`, error.stack)
      }
    }

    const totalDuration = Date.now() - startTime
    console.log(`[PREPARE-NEXT-MONTH] Completed in ${totalDuration}ms. Results:`, results)

    return NextResponse.json({
      message: `Prepared assignments for ${monthYear}`,
      year,
      month,
      duration: `${totalDuration}ms`,
      results,
      testMode: !!testUserId,
      note: testUserId 
        ? `Tested for user: ${testUserId}. To test for your user, add ?userId=YOUR_USER_ID to the URL. You can find your user ID in the browser console: localStorage.getItem('supabase.auth.token') or check your Supabase auth.users table.`
        : 'To test for a specific user, add ?userId=YOUR_USER_ID to the URL',
    })
  } catch (error: any) {
    const totalDuration = Date.now() - startTime
    console.error(`[PREPARE-NEXT-MONTH] Fatal error after ${totalDuration}ms:`, error)
    console.error(`[PREPARE-NEXT-MONTH] Error stack:`, error.stack)
    return NextResponse.json(
      { 
        error: error.message || 'Failed to prepare assignments',
        details: error.toString(),
        duration: `${totalDuration}ms`,
      },
      { status: 500 }
    )
  }
}

