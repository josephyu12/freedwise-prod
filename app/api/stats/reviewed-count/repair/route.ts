import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const PAGE = 1000

/**
 * POST /api/stats/reviewed-count/repair
 * Body: { month?: "YYYY-MM" }  (defaults to previous calendar month)
 *
 * Backfills highlight_months_reviewed for the given month for any highlight that
 * has a rating in daily_summary_highlights for that month but no row in
 * highlight_months_reviewed. Use this after a failed sync (e.g. lost signal)
 * so "Last month reviewed" and other stats stay consistent.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let monthYear: string
    try {
      const body = await request.json().catch(() => ({}))
      monthYear = body?.month
    } catch {
      monthYear = ''
    }
    if (!monthYear || typeof monthYear !== 'string') {
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

    const { data: summaries } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('date', startOfMonth)
      .lte('date', endOfMonth)
    const summaryIds = (summaries || []).map((s: { id: string }) => s.id)
    if (summaryIds.length === 0) {
      return NextResponse.json({
        month: monthYear,
        repaired: 0,
        message: 'No daily summaries for this month.',
      })
    }

    const ratedHighlightIds = new Set<string>()
    let from = 0
    while (true) {
      const { data: rated, error: ratedError } = await supabase
        .from('daily_summary_highlights')
        .select('highlight_id')
        .in('daily_summary_id', summaryIds)
        .not('rating', 'is', null)
        .range(from, from + PAGE - 1)
      if (ratedError) throw ratedError
      const page = (rated || []) as Array<{ highlight_id: string }>
      page.forEach((r) => ratedHighlightIds.add(r.highlight_id))
      if (page.length < PAGE) break
      from += PAGE
    }

    const existingHmr = new Set<string>()
    from = 0
    while (true) {
      const { data, error } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', monthYear)
        .range(from, from + PAGE - 1)
      if (error) throw error
      const page = (data || []) as Array<{ highlight_id: string }>
      page.forEach((r) => existingHmr.add(r.highlight_id))
      if (page.length < PAGE) break
      from += PAGE
    }

    const toInsert = [...ratedHighlightIds].filter((id) => !existingHmr.has(id))
    if (toInsert.length === 0) {
      return NextResponse.json({
        month: monthYear,
        repaired: 0,
        message: 'No missing reviewed rows to backfill.',
      })
    }

    const { error: upsertError } = await (supabase
      .from('highlight_months_reviewed') as any)
      .upsert(
        toInsert.map((highlight_id) => ({ highlight_id, month_year: monthYear })),
        { onConflict: 'highlight_id,month_year' }
      )
    if (upsertError) throw upsertError

    // Remove spurious current-month HMR rows: if the daily page previously used "today"
    // when marking reviewed, it may have written the current month (e.g. 2026-02) while
    // the user was actually reviewing last month (2026-01). Delete current-month HMR rows
    // for highlights that have no rating in the current month's summaries.
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const currentMonthYear = `${currentYear}-${String(currentMonth).padStart(2, '0')}`
    const currentStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`
    const currentEndDay = new Date(currentYear, currentMonth, 0).getDate()
    const currentEnd = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(currentEndDay).padStart(2, '0')}`

    const { data: currentSummaries } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('date', currentStart)
      .lte('date', currentEnd)
    const currentSummaryIds = (currentSummaries || []).map((s: { id: string }) => s.id)
    const ratedInCurrentMonth = new Set<string>()
    if (currentSummaryIds.length > 0) {
      let fromCur = 0
      while (true) {
        const { data: curRated, error: curErr } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id')
          .in('daily_summary_id', currentSummaryIds)
          .not('rating', 'is', null)
          .range(fromCur, fromCur + PAGE - 1)
        if (curErr) break
        const page = (curRated || []) as Array<{ highlight_id: string }>
        page.forEach((r) => ratedInCurrentMonth.add(r.highlight_id))
        if (page.length < PAGE) break
        fromCur += PAGE
      }
    }

    const { data: currentHmrRows } = await supabase
      .from('highlight_months_reviewed')
      .select('id, highlight_id')
      .eq('month_year', currentMonthYear)
    const toDelete = (currentHmrRows || []).filter(
      (r: { id: string; highlight_id: string }) => !ratedInCurrentMonth.has(r.highlight_id)
    )
    let removed = 0
    for (const row of toDelete) {
      const { error: delErr } = await supabase
        .from('highlight_months_reviewed')
        .delete()
        .eq('id', row.id)
      if (!delErr) removed++
    }

    return NextResponse.json({
      month: monthYear,
      repaired: toInsert.length,
      removedSpuriousCurrentMonth: removed,
      message: [
        toInsert.length > 0 && `Backfilled ${toInsert.length} highlight(s) as reviewed for ${monthYear}.`,
        removed > 0 && `Removed ${removed} incorrect current-month "reviewed" entries.`,
      ].filter(Boolean).join(' ') || `No missing entries to sync.`,
    })
  } catch (error: any) {
    console.error('Error in reviewed-count repair:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to repair reviewed status' },
      { status: 500 }
    )
  }
}
