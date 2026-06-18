import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getCycleForDate,
  cycleSeed,
  cycleKeyForDate,
  getUserReviewSettings,
  normalizeFreq,
} from '@/lib/cycle'
import { packIntoDates, Scored } from '@/lib/binPack'

/**
 * POST /api/daily/apply-frequency
 * Body { frequency: number, localDate?: string }
 *
 * Changes the user's review frequency and re-tiles the CURRENT cycle onto the new
 * shape (REVIEW_FREQUENCY_PLAN.md D7), best-effort:
 *   1. Persist the new frequency.
 *   2. Already-reviewed-this-period highlights stay done — their rated rows are
 *      preserved, and their ledger row is re-keyed to the new cycle key (one row
 *      replaced by one row, so resurface_count is unchanged).
 *   3. The unreviewed remainder is re-packed deterministically across the new
 *      cycle's remaining days (today → end), seeded by cycleSeed(newCycle) so
 *      switching back to a prior frequency reproduces the earlier layout.
 *   4. Future, misaligned pre-portioned days (unrated, past the new cycle's end)
 *      are cleared; the daily cron re-portions the next cycle when due.
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

    const { freq: oldFreq } = await getUserReviewSettings(supabase, user.id)

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

    // 2. Rated highlights in [newCycle.start, today] → latest rating date each.
    //    (Ground truth is the per-day rating, which survives any key change.)
    const ratedLatestDate = new Map<string, string>()
    {
      const { data: winSummaries } = await supabase
        .from('daily_summaries')
        .select('id, date')
        .eq('user_id', user.id)
        .gte('date', newCycle.startDate)
        .lte('date', today)
      const winTyped = (winSummaries || []) as Array<{ id: string; date: string }>
      if (winTyped.length > 0) {
        const dateById = new Map(winTyped.map((s) => [s.id, s.date]))
        let aFrom = 0
        while (true) {
          const { data: aPage, error: aErr } = await supabase
            .from('daily_summary_highlights')
            .select('highlight_id, daily_summary_id, rating')
            .in('daily_summary_id', winTyped.map((s) => s.id))
            .not('rating', 'is', null)
            .range(aFrom, aFrom + PAGE - 1)
          if (aErr) throw aErr
          const page = (aPage || []) as Array<{ highlight_id: string; daily_summary_id: string }>
          for (const a of page) {
            const d = dateById.get(a.daily_summary_id)
            if (!d) continue
            const prev = ratedLatestDate.get(a.highlight_id)
            if (!prev || d > prev) ratedLatestDate.set(a.highlight_id, d)
          }
          if (page.length < PAGE) break
          aFrom += PAGE
        }
      }
    }

    // Re-key the dedup ledger in place: rename old cycle key → new cycle key.
    let reKeyed = 0
    for (const [highlightId, ratingDate] of ratedLatestDate.entries()) {
      const oldKey = cycleKeyForDate(ratingDate, oldFreq)
      if (oldKey !== newCycle.key) {
        await supabase
          .from('highlight_months_reviewed')
          .delete()
          .eq('highlight_id', highlightId)
          .eq('month_year', oldKey)
      }
      await (supabase.from('highlight_months_reviewed') as any).upsert(
        { highlight_id: highlightId, month_year: newCycle.key },
        { onConflict: 'highlight_id,month_year' }
      )
      reKeyed++
    }

    // 4. Clear unrated assignments from the current cycle start onward (current
    //    cycle remaining + any misaligned future), preserving rated rows. Then
    //    drop emptied summaries.
    {
      const { data: fwdSummaries } = await supabase
        .from('daily_summaries')
        .select('id, date')
        .eq('user_id', user.id)
        .gte('date', newCycle.startDate)
      const fwdTyped = (fwdSummaries || []) as Array<{ id: string; date: string }>
      if (fwdTyped.length > 0) {
        const ids = fwdTyped.map((s) => s.id)
        // Delete unrated assignment rows.
        await supabase
          .from('daily_summary_highlights')
          .delete()
          .in('daily_summary_id', ids)
          .is('rating', null)
        // Drop summaries that now have no assignments at all.
        const { data: remaining } = await supabase
          .from('daily_summary_highlights')
          .select('daily_summary_id')
          .in('daily_summary_id', ids)
        const withRows = new Set((remaining || []).map((r: any) => r.daily_summary_id))
        const emptyIds = ids.filter((id) => !withRows.has(id))
        if (emptyIds.length > 0) {
          await supabase.from('daily_summaries').delete().in('id', emptyIds)
        }
      }
    }

    // 5. Re-pack the unreviewed remainder across the new cycle's remaining days.
    let allHighlightsData: Array<{ id: string; text: string; html_content: string | null }> = []
    let from = 0
    while (true) {
      const { data, error: pErr } = await supabase
        .from('highlights')
        .select('id, text, html_content')
        .eq('user_id', user.id)
        .eq('archived', false)
        .range(from, from + PAGE - 1)
      if (pErr) throw pErr
      const page = (data || []) as Array<{ id: string; text: string; html_content: string | null }>
      allHighlightsData = allHighlightsData.concat(page)
      if (page.length < PAGE) break
      from += PAGE
    }

    // Reviewed-this-cycle (ledger, now re-keyed) — excluded from the re-pack.
    const reviewedIds = new Set<string>()
    let rFrom = 0
    while (true) {
      const { data: rPage, error: rErr } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', newCycle.key)
        .range(rFrom, rFrom + PAGE - 1)
      if (rErr) throw rErr
      const page = (rPage || []) as Array<{ highlight_id: string }>
      for (const r of page) reviewedIds.add(r.highlight_id)
      if (page.length < PAGE) break
      rFrom += PAGE
    }

    const U: Scored[] = allHighlightsData
      .filter((h) => !reviewedIds.has(h.id) && !ratedLatestDate.has(h.id))
      .map((h) => {
        const content = h.html_content || h.text || ''
        return { id: h.id, text: h.text, html_content: h.html_content, score: content.replace(/<[^>]*>/g, '').length }
      })

    const remainingDates = newCycle.dates.filter((d) => d >= today)
    let packed = 0
    if (U.length > 0 && remainingDates.length > 0) {
      // Existing (rated) summaries in the remaining window, to reuse their ids.
      const { data: existing } = await supabase
        .from('daily_summaries')
        .select('id, date')
        .eq('user_id', user.id)
        .gte('date', today)
        .lte('date', newCycle.endDate)
      const existingByDate = new Map((existing || []).map((s: any) => [s.date, s.id]))

      const buckets = packIntoDates(U, remainingDates, cycleSeed(newCycle))
      for (const bucket of buckets) {
        if (bucket.highlights.length === 0) continue
        let summaryId: string | null = existingByDate.get(bucket.date) ?? null
        if (!summaryId) {
          const { data: summaryData, error: sErr } = await (supabase.from('daily_summaries') as any)
            .insert([{ date: bucket.date, user_id: user.id }])
            .select()
            .single()
          if (sErr) throw sErr
          summaryId = summaryData.id
        }
        const { error: linkError } = await (supabase.from('daily_summary_highlights') as any)
          .upsert(
            bucket.highlights.map((h) => ({ daily_summary_id: summaryId, highlight_id: h.id })),
            { onConflict: 'daily_summary_id,highlight_id', ignoreDuplicates: true }
          )
        if (linkError) throw linkError
        packed += bucket.highlights.length
      }
    }

    return NextResponse.json({
      message: `Applied frequency ${frequency}. Re-tiled cycle ${newCycle.key}.`,
      frequency,
      cycleKey: newCycle.key,
      reKeyed,
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
