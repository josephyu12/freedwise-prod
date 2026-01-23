import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/daily/redistribute
 * Redistributes highlights for the current month when new highlights are added
 * This should be called when a highlight is added (unless it's the last day of the month)
 */
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

    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const dayOfMonth = now.getDate()
    const daysInMonth = new Date(year, month, 0).getDate()

    // Don't redistribute if it's the last day of the month
    if (dayOfMonth === daysInMonth) {
      return NextResponse.json({
        message: 'Last day of month - skipping redistribution',
        skipped: true,
      })
    }

    const monthYear = `${year}-${String(month).padStart(2, '0')}`

    // Get all unarchived highlights for this user
    const { data: allHighlightsData, error: highlightsError } = await supabase
      .from('highlights')
      .select('id, text, html_content')
      .eq('user_id', user.id)
      .eq('archived', false)

    if (highlightsError) throw highlightsError

    // Get highlights that have already been reviewed for this month
    const { data: reviewedHighlightsData, error: reviewedError } = await supabase
      .from('highlight_months_reviewed')
      .select('highlight_id')
      .eq('month_year', monthYear)

    if (reviewedError) throw reviewedError

    const reviewedHighlightIds = new Set(
      (reviewedHighlightsData || []).map((r: any) => r.highlight_id)
    )

    // Filter out highlights that have already been reviewed this month
    const allHighlights = ((allHighlightsData || []) as Array<{
      id: string
      text: string
      html_content: string | null
    }>).filter((h) => !reviewedHighlightIds.has(h.id))

    if (allHighlights.length === 0) {
      return NextResponse.json({
        message: 'No highlights to redistribute',
      })
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

    // Seeded shuffle function for deterministic randomization
    const seededShuffle = <T,>(array: T[], seed: number): T[] => {
      const shuffled = [...array]
      let random = seed
      
      const seededRandom = () => {
        random = (random * 9301 + 49297) % 233280
        return random / 233280
      }
      
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(seededRandom() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      
      return shuffled
    }

    // Create a seed from year and month for deterministic but varied shuffling
    const seed = year * 100 + month
    
    // Shuffle highlights with seed to add variety month-to-month
    // Then sort by score for better bin-packing
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

    const { data: existingSummaries, error: existingError } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('date', startDate)
      .lte('date', endDate)

    if (existingError) throw existingError

    if (existingSummaries && existingSummaries.length > 0) {
      const summaryIds = existingSummaries.map((s: any) => s.id)
      
      await supabase
        .from('daily_summary_highlights')
        .delete()
        .in('daily_summary_id', summaryIds)

      await supabase
        .from('daily_summaries')
        .delete()
        .in('id', summaryIds)
    }

    // Recreate assignments
    const createdAssignments: any[] = []

    for (const assignment of days) {
      if (assignment.highlights.length === 0) continue

      const date = `${year}-${String(month).padStart(2, '0')}-${String(assignment.day).padStart(2, '0')}`

      const { data: summaryData, error: summaryError } = await (supabase
        .from('daily_summaries') as any)
        .insert([{ date, user_id: user.id }])
        .select()
        .single()

      if (summaryError) throw summaryError

      const summaryHighlights = assignment.highlights.map((h) => ({
        daily_summary_id: summaryData.id,
        highlight_id: h.id,
      }))

      const { error: linkError } = await (supabase
        .from('daily_summary_highlights') as any)
        .insert(summaryHighlights)

      if (linkError) throw linkError

      createdAssignments.push({
        day: assignment.day,
        date,
        highlightCount: assignment.highlights.length,
        totalScore: assignment.totalScore,
      })
    }

    // NOTE: We do NOT mark highlights as reviewed here.
    // Highlights should only be marked as reviewed when they receive a rating
    // in the daily review page (handleRatingChange in app/daily/page.tsx)

    return NextResponse.json({
      message: `Redistributed ${allHighlights.length} highlights across ${daysInMonth} days`,
      assignments: createdAssignments,
      totalHighlights: allHighlights.length,
      daysInMonth,
    })
  } catch (error: any) {
    console.error('Error redistributing highlights:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to redistribute highlights' },
      { status: 500 }
    )
  }
}

