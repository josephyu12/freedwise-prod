import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCycle, getCycleForDate, prevCycle, cycleLabel, getUserReviewSettings } from '@/lib/cycle'

const PAGE = 1000
const TEXT_SNIPPET_LENGTH = 120

/**
 * GET /api/stats/reviewed-count?cycle=YYYY-MM   (or legacy ?month=YYYY-MM)
 * Returns how many highlights were reviewed for the given CYCLE, and a list of
 * highlights that were added before that cycle ended but were not reviewed.
 * Defaults to the previous cycle if no param is given.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { freq } = await getUserReviewSettings(supabase, user.id)

    const { searchParams } = new URL(request.url)
    const param = searchParams.get('cycle') || searchParams.get('month')
    let cycle
    if (param) {
      if (!/^\d{4}-\d{2}$/.test(param)) {
        return NextResponse.json({ error: 'Invalid cycle; use YYYY-MM' }, { status: 400 })
      }
      const [py, pm] = param.split('-').map(Number)
      cycle = getCycle(py, pm, freq)
    } else {
      const now = new Date()
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      cycle = prevCycle(getCycleForDate(todayIso, freq))
    }

    const monthYear = cycle.key
    const startOfMonth = cycle.startDate
    const endOfMonth = cycle.endDate
    // “Before the cycle ended” = strictly before the day after the cycle's last day.
    const createdBefore = `${endOfMonth}T23:59:59.999Z`

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

    // Also treat as reviewed any highlight that has a rating in daily_summary_highlights for this month
    // (handles the case where rating was saved but highlight_months_reviewed insert failed, e.g. lost signal)
    const { data: summariesForMonth } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('date', startOfMonth)
      .lte('date', endOfMonth)
    const summaryIdsForMonth = (summariesForMonth || []).map((s: { id: string }) => s.id)
    if (summaryIdsForMonth.length > 0) {
      from = 0
      while (true) {
        const { data: rated, error: ratedError } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id')
          .in('daily_summary_id', summaryIdsForMonth)
          .not('rating', 'is', null)
          .range(from, from + PAGE - 1)
        if (ratedError) throw ratedError
        const page = (rated || []) as Array<{ highlight_id: string }>
        page.forEach((r) => { if (userHighlightIds.has(r.highlight_id)) reviewedIds.add(r.highlight_id) })
        if (page.length < PAGE) break
        from += PAGE
      }
    }

    const count = reviewedIds.size

    const highlightsAddedBeforeMonthEnd: Array<{ id: string; text: string; created_at: string; archived: boolean | null }> = []
    from = 0
    while (true) {
      const { data, error } = await supabase
        .from('highlights')
        .select('id, text, created_at, archived')
        .eq('user_id', user.id)
        .lt('created_at', createdBefore)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)
      if (error) throw error
      const page = (data || []) as Array<{ id: string; text: string; created_at: string; archived: boolean | null }>
      highlightsAddedBeforeMonthEnd.push(...page)
      if (page.length < PAGE) break
      from += PAGE
    }

    const unreviewed = highlightsAddedBeforeMonthEnd.filter((h) => !reviewedIds.has(h.id))
    if (unreviewed.length === 0) {
      return NextResponse.json({
        count,
        month: monthYear,
        cycleKey: monthYear,
        cycleLabel: cycleLabel(cycle),
        cycleStart: cycle.startDate,
        cycleEnd: cycle.endDate,
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
        archived: !!h.archived,
      }
    })

    return NextResponse.json({
      count,
      month: monthYear,
      cycleKey: monthYear,
      cycleLabel: cycleLabel(cycle),
      cycleStart: cycle.startDate,
      cycleEnd: cycle.endDate,
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
