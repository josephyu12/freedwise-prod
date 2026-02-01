import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const PAGE = 1000
const TEXT_SNIPPET_LENGTH = 120

/**
 * GET /api/stats/reviewed-count?month=YYYY-MM
 * Returns how many highlights were reviewed for the given month, and a list of highlights
 * that were added before that month ended but were not reviewed, with assignment info.
 * Defaults to the previous calendar month if month is omitted.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    let monthYear = searchParams.get('month')
    if (!monthYear) {
      const now = new Date()
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      monthYear = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`
    }
    if (!/^\d{4}-\d{2}$/.test(monthYear)) {
      return NextResponse.json({ error: 'Invalid month; use YYYY-MM' }, { status: 400 })
    }

    const [y, m] = monthYear.split('-').map(Number)
    const startOfMonth = `${y}-${String(m).padStart(2, '0')}-01`
    const daysInMonth = new Date(y, m, 0).getDate()
    const endOfMonth = `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`
    // “Before the month ended” = strictly before the first day of the next month (UTC, consistent with rest of app)
    const nextMonth = m === 12 ? 1 : m + 1
    const nextYear = m === 12 ? y + 1 : y
    const createdBefore = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00.000Z`

    const userHighlightIds = new Set<string>()
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('highlights')
        .select('id')
        .eq('user_id', user.id)
        .range(from, from + PAGE - 1)
      if (error) throw error
      const page = (data || []) as Array<{ id: string }>
      page.forEach((r) => userHighlightIds.add(r.id))
      if (page.length < PAGE) break
      from += PAGE
    }

    const reviewedIds = new Set<string>()
    from = 0
    while (true) {
      const { data, error } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', monthYear)
        .range(from, from + PAGE - 1)
      if (error) throw error
      const page = (data || []) as Array<{ highlight_id: string }>
      page.forEach((r) => { if (userHighlightIds.has(r.highlight_id)) reviewedIds.add(r.highlight_id) })
      if (page.length < PAGE) break
      from += PAGE
    }

    const count = reviewedIds.size

    const highlightsAddedBeforeMonthEnd: Array<{ id: string; text: string; created_at: string }> = []
    from = 0
    while (true) {
      const { data, error } = await supabase
        .from('highlights')
        .select('id, text, created_at')
        .eq('user_id', user.id)
        .lt('created_at', createdBefore)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)
      if (error) throw error
      const page = (data || []) as Array<{ id: string; text: string; created_at: string }>
      highlightsAddedBeforeMonthEnd.push(...page)
      if (page.length < PAGE) break
      from += PAGE
    }

    const unreviewed = highlightsAddedBeforeMonthEnd.filter((h) => !reviewedIds.has(h.id))
    if (unreviewed.length === 0) {
      return NextResponse.json({
        count,
        month: monthYear,
        unreviewedHighlights: [],
      })
    }

    const { data: summaries } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('user_id', user.id)
      .gte('date', startOfMonth)
      .lte('date', endOfMonth)
    const summaryList = (summaries || []) as Array<{ id: string; date: string }>
    const highlightToDate = new Map<string, string>()
    if (summaryList.length > 0) {
      const summaryIds = summaryList.map((s) => s.id)
      const dateBySummaryId = new Map(summaryList.map((s) => [s.id, s.date]))
      from = 0
      while (true) {
        const { data: assignments, error } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id, daily_summary_id')
          .in('daily_summary_id', summaryIds)
          .range(from, from + PAGE - 1)
        if (error) throw error
        const page = (assignments || []) as Array<{ highlight_id: string; daily_summary_id: string }>
        for (const a of page) {
          const date = dateBySummaryId.get(a.daily_summary_id)
          if (date) highlightToDate.set(a.highlight_id, date)
        }
        if (page.length < PAGE) break
        from += PAGE
      }
    }

    const unreviewedHighlights = unreviewed.map((h) => {
      const raw = h.text || ''
      const plain = raw.replace(/<[^>]*>/g, '').trim()
      const snippet = plain.length <= TEXT_SNIPPET_LENGTH ? plain : plain.slice(0, TEXT_SNIPPET_LENGTH) + '…'
      return {
        id: h.id,
        textSnippet: snippet,
        created_at: h.created_at,
        assigned_date: highlightToDate.get(h.id) ?? null,
      }
    })

    return NextResponse.json({
      count,
      month: monthYear,
      unreviewedHighlights,
    })
  } catch (error: any) {
    console.error('Error in reviewed-count:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to get reviewed count' },
      { status: 500 }
    )
  }
}
