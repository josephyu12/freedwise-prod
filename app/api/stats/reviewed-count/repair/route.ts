import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCycle, getCycleForDate, prevCycle, getUserReviewSettings } from '@/lib/cycle'

const PAGE = 1000

/**
 * POST /api/stats/reviewed-count/repair
 * Body: { cycle?: "YYYY-MM" }  (legacy: { month })  — defaults to previous cycle
 *
 * Backfills highlight_months_reviewed for the given CYCLE for any highlight that
 * has a rating in daily_summary_highlights for that cycle but no ledger row. Use
 * this after a failed sync (e.g. lost signal) so "Last cycle reviewed" stats stay
 * consistent.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { freq } = await getUserReviewSettings(supabase, user.id)

    let param = ''
    try {
      const body = await request.json().catch(() => ({}))
      param = body?.cycle || body?.month || ''
    } catch {
      param = ''
    }

    let cycle
    if (param && typeof param === 'string') {
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

    // Remove spurious current-cycle HMR rows: if a rating path previously used "today"
    // when marking reviewed, it may have written the current cycle key while the user was
    // actually reviewing the previous cycle. Delete current-cycle HMR rows for highlights
    // that have no rating in the current cycle's summaries.
    const now = new Date()
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const currentCycle = getCycleForDate(todayIso, freq)
    const currentMonthYear = currentCycle.key
    const currentStart = currentCycle.startDate
    const currentEnd = currentCycle.endDate

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
    const rows = (currentHmrRows || []) as Array<{ id: string; highlight_id: string }>
    const toDelete = rows.filter((r) => !ratedInCurrentMonth.has(r.highlight_id))
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
