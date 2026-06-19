import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getCycleForDate,
  getUserReviewSettings,
  normalizeFreq,
} from '@/lib/cycle'
import { Scored } from '@/lib/binPack'
import { computeToDoLayout } from '@/lib/retile'

/**
 * POST /api/daily/apply-frequency
 * Body { frequency: number, localDate?: string }
 *
 * Re-tiles the user's schedule onto a new review cadence. ONE unified operation
 * for every change (grow or shrink) — the direction falls out of which cycle
 * `today` lands in. See REVIEW_FREQUENCY_PLAN.md (anchored/reversible model).
 *
 * MODEL — rated rows are immutable anchors:
 *   • A rated daily_summary_highlights row is NEVER moved or deleted here. It is
 *     the permanent record of a review and its date is the truth.
 *   • A highlight is "done for the new cycle" iff it has a rated row dated inside
 *     the cycle. (When GROWING, this is the duplicate check: a highlight that was
 *     still to-do in the current month but was already reviewed in another month
 *     of the larger cycle is found here and stays done — never re-queued.)
 *   • Only UNRATED (to-do) rows are recomputed: cleared, then the unreviewed
 *     remainder is packed deterministically across [today … cycle end].
 *
 * Because every input to the pack (the unreviewed set, the day range, the fixed
 * cycleSeed, and the per-day load seeded from immutable rated rows) is a pure
 * function of the cycle + immutable history + today, switching back and forth
 * reproduces the exact same layout (reversible) and nothing is ever lost.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let frequency = 1
    let localDate: string | null = null
    try {
      const body = await request.json().catch(() => ({}))
      frequency = normalizeFreq((body as { frequency?: number }).frequency)
      if (typeof (body as { localDate?: unknown }).localDate === 'string') {
        localDate = (body as { localDate: string }).localDate
      }
    } catch {
      /* defaults */
    }

    // Keep the on/off flag; only the frequency changes here.
    const { enabled } = await getUserReviewSettings(supabase, user.id)

    const now = new Date()
    const today = localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)
      ? localDate
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    // 1. Persist the new frequency (preserve enabled).
    const { error: upsertErr } = await (supabase.from('user_review_settings') as any)
      .upsert({ user_id: user.id, frequency_months: frequency }, { onConflict: 'user_id' })
    if (upsertErr) throw upsertErr

    const newCycle = getCycleForDate(today, frequency)
    const PAGE = 1000

    // Load active highlights once (needed for scores and the unreviewed set).
    let allHighlightsData: Array<{ id: string; text: string; html_content: string | null }> = []
    {
      let from = 0
      while (true) {
        const { data, error } = await supabase
          .from('highlights')
          .select('id, text, html_content')
          .eq('user_id', user.id)
          .eq('archived', false)
          .range(from, from + PAGE - 1)
        if (error) throw error
        const page = (data || []) as Array<{ id: string; text: string; html_content: string | null }>
        allHighlightsData = allHighlightsData.concat(page)
        if (page.length < PAGE) break
        from += PAGE
      }
    }
    const scoreById = new Map<string, number>(
      allHighlightsData.map((h) => {
        const content = h.html_content || h.text || ''
        return [h.id, content.replace(/<[^>]*>/g, '').length]
      })
    )

    // Summaries spanning the whole new cycle (may be 1–12 calendar months).
    const { data: cycleSummariesData, error: csErr } = await supabase
      .from('daily_summaries')
      .select('id, date')
      .eq('user_id', user.id)
      .gte('date', newCycle.startDate)
      .lte('date', newCycle.endDate)
    if (csErr) throw csErr
    const cycleSummaries = (cycleSummariesData || []) as Array<{ id: string; date: string }>
    const cycleSummaryIds = cycleSummaries.map((s) => s.id)
    const dateById = new Map(cycleSummaries.map((s) => [s.id, s.date]))

    // 2/3. doneIds = highlights with a RATED row dated anywhere in the cycle
    //      (the cross-month duplicate check), plus per-day rated load for balance.
    const doneIds = new Set<string>()
    const ratedScoreByDate = new Map<string, number>()
    if (cycleSummaryIds.length > 0) {
      let aFrom = 0
      while (true) {
        const { data: aPage, error: aErr } = await supabase
          .from('daily_summary_highlights')
          .select('highlight_id, daily_summary_id, rating')
          .in('daily_summary_id', cycleSummaryIds)
          .not('rating', 'is', null)
          .range(aFrom, aFrom + PAGE - 1)
        if (aErr) throw aErr
        const page = (aPage || []) as Array<{ highlight_id: string; daily_summary_id: string }>
        for (const a of page) {
          doneIds.add(a.highlight_id)
          const d = dateById.get(a.daily_summary_id)
          if (d) ratedScoreByDate.set(d, (ratedScoreByDate.get(d) ?? 0) + (scoreById.get(a.highlight_id) ?? 0))
        }
        if (page.length < PAGE) break
        aFrom += PAGE
      }
    }

    // 4. Rebuild the dedup ledger for this cycle key so the daily cron / assign
    //    treat exactly the done highlights as reviewed. Minimal diff (preserve
    //    existing rows' created_at): delete stale, insert missing.
    {
      const existing = new Set<string>()
      let rFrom = 0
      while (true) {
        const { data: rPage, error: rErr } = await supabase
          .from('highlight_months_reviewed')
          .select('highlight_id')
          .eq('month_year', newCycle.key)
          .range(rFrom, rFrom + PAGE - 1)
        if (rErr) throw rErr
        const page = (rPage || []) as Array<{ highlight_id: string }>
        for (const r of page) existing.add(r.highlight_id)
        if (page.length < PAGE) break
        rFrom += PAGE
      }
      const toDelete = [...existing].filter((id) => !doneIds.has(id))
      const toInsert = [...doneIds].filter((id) => !existing.has(id))
      for (let i = 0; i < toDelete.length; i += 200) {
        const { error } = await supabase
          .from('highlight_months_reviewed')
          .delete()
          .eq('month_year', newCycle.key)
          .in('highlight_id', toDelete.slice(i, i + 200))
        if (error) throw error
      }
      for (let i = 0; i < toInsert.length; i += 500) {
        const rows = toInsert.slice(i, i + 500).map((id) => ({ highlight_id: id, month_year: newCycle.key }))
        const { error } = await (supabase.from('highlight_months_reviewed') as any)
          .upsert(rows, { onConflict: 'highlight_id,month_year', ignoreDuplicates: true })
        if (error) throw error
      }
    }

    // 5. Clear ONLY unrated rows in the cycle (the stale to-do); rated rows stay
    //    put. Then drop summaries left with no rows.
    if (cycleSummaryIds.length > 0) {
      for (let i = 0; i < cycleSummaryIds.length; i += 200) {
        const { error } = await supabase
          .from('daily_summary_highlights')
          .delete()
          .in('daily_summary_id', cycleSummaryIds.slice(i, i + 200))
          .is('rating', null)
        if (error) throw error
      }
      const withRows = new Set<string>()
      for (let i = 0; i < cycleSummaryIds.length; i += 200) {
        const { data: rem } = await supabase
          .from('daily_summary_highlights')
          .select('daily_summary_id')
          .in('daily_summary_id', cycleSummaryIds.slice(i, i + 200))
        for (const r of (rem || []) as Array<{ daily_summary_id: string }>) withRows.add(r.daily_summary_id)
      }
      const emptyIds = cycleSummaryIds.filter((id) => !withRows.has(id))
      for (let i = 0; i < emptyIds.length; i += 200) {
        const { error } = await supabase.from('daily_summaries').delete().in('id', emptyIds.slice(i, i + 200))
        if (error) throw error
      }
    }

    // 6/7. Pack the unreviewed remainder across [today … cycle end], balancing
    //      per-day TOTAL by seeding each pack day with its rated load. (Pure,
    //      reversible — see lib/retile.ts.)
    const highlights: Scored[] = allHighlightsData.map((h) => ({
      id: h.id,
      text: h.text,
      html_content: h.html_content,
      score: scoreById.get(h.id) ?? 0,
    }))
    const buckets = computeToDoLayout({
      today,
      cycle: newCycle,
      highlights,
      doneIds,
      ratedScoreByDate,
    })

    // 8. Insert the new unrated rows (reuse existing summaries by date, else create).
    const summaryIdByDate = new Map(cycleSummaries.map((s) => [s.date, s.id]))
    let packed = 0
    for (const bucket of buckets) {
      if (bucket.highlights.length === 0) continue
      let summaryId: string | null = summaryIdByDate.get(bucket.date) ?? null
      if (!summaryId) {
        const { data: sd, error: se } = await (supabase.from('daily_summaries') as any)
          .insert([{ date: bucket.date, user_id: user.id }])
          .select()
          .single()
        if (se) throw se
        summaryId = sd.id as string
        summaryIdByDate.set(bucket.date, summaryId)
      }
      const { error: le } = await (supabase.from('daily_summary_highlights') as any).upsert(
        bucket.highlights.map((h) => ({ daily_summary_id: summaryId!, highlight_id: h.id })),
        { onConflict: 'daily_summary_id,highlight_id', ignoreDuplicates: true }
      )
      if (le) throw le
      packed += bucket.highlights.length
    }

    return NextResponse.json({
      message: `Applied frequency ${frequency}. Re-tiled cycle ${newCycle.key}.`,
      frequency,
      enabled,
      cycleKey: newCycle.key,
      doneCount: doneIds.size,
      repacked: packed,
    })
  } catch (error: any) {
    console.error('Error applying frequency:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to apply frequency' },
      { status: 500 }
    )
  }
}
