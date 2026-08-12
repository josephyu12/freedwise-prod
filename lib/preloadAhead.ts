// Background pre-fetcher for review-ahead highlights.
//
// Runs after the normal /review page load finishes (fire-and-forget) to fill the
// 'review-ahead' IndexedDB cache. When the user later opens ?ahead=1 while
// offline, the page reads this cache instead of hitting the network, making the
// transition seamless.
//
// Only fetches the FUTURE portion of the cycle (date > today → cycle.endDate),
// since the caller supplies the already-fetched today + earlier rows from the
// normal load. This avoids duplicating the main query.

import {
  reconcileAheadOrder,
  readAheadOrder,
  readLegacyAheadOrder,
  writeAheadOrder,
  fetchAheadOrder,
  storeAheadOrder,
} from '@/lib/aheadOrder'
import { applyPendingActions } from '@/lib/pendingOverlay'
import { listReplayable } from '@/lib/offlineReplay'
import { cacheReviewAheadData } from '@/lib/offlineStore'
import type { Cycle } from '@/lib/cycle'

// ─── Single-flight guard ────────────────────────────────────────────────────
//
// Multiple loads can fire in quick succession (visibility change, sync-complete,
// manual refresh). Only one pre-load at a time; later callers join the existing
// promise rather than spawning a second.

let preloadPromise: Promise<void> | null = null

interface PreloadAheadParams {
  supabase: any
  userId: string
  cycle: Cycle
  today: string
  /** Today + catch-up rows from the normal load, post-applyPendingActions. */
  allRows: any[]
  categories: any[]
  pinnedIds: string[]
}

/**
 * Pre-fetch ahead highlights in the background and cache them to IndexedDB.
 *
 * Fire-and-forget: failures only warn. The normal review page is never blocked
 * or affected — the pre-loaded cache is an opportunistic bonus for offline use.
 */
export function preloadAheadHighlights(params: PreloadAheadParams): void {
  if (preloadPromise) return
  preloadPromise = doPreload(params).finally(() => {
    preloadPromise = null
  })
}

async function doPreload({
  supabase,
  userId,
  cycle,
  today,
  allRows,
  categories,
  pinnedIds,
}: PreloadAheadParams): Promise<void> {
  try {
    // ── Fetch future highlights (the delta between normal and ahead mode) ──

    const PAGE = 1000
    const fetchPage = (from: number) =>
      supabase
        .from('daily_summary_highlights')
        .select(`
          id,
          highlight_id,
          rating,
          daily_summaries!inner(id, date),
          highlight:highlights!inner (
            id,
            text,
            html_content,
            source,
            author,
            archived,
            highlight_categories (
              category:categories (*)
            )
          )
        `)
        .gt('daily_summaries.date', today)
        .lte('daily_summaries.date', cycle.endDate)
        .eq('daily_summaries.user_id', userId)
        .eq('highlight.archived', false)
        .order('rating', { ascending: false, nullsFirst: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)

    // Kick off the frozen-order read concurrently with the highlights fetch.
    const aheadOrderPromise = fetchAheadOrder(supabase, userId, cycle.key)

    let hlData: any[] = []
    let from = 0
    while (true) {
      const { data: page, error } = await fetchPage(from)
      if (error) throw error
      const list = page || []
      hlData = hlData.concat(list)
      if (list.length < PAGE) break
      from += PAGE
    }

    if (hlData.length === 0) {
      // No future highlights in this cycle — nothing worth pre-caching.
      return
    }

    // ── Map to ReviewHighlight shape ──

    const futureServerRows = hlData.map((sh: any) => ({
      id: sh.id,
      daily_summary_id: sh.daily_summaries?.id || '',
      highlight_id: sh.highlight_id,
      rating: sh.rating,
      date: sh.daily_summaries?.date || '',
      highlight: sh.highlight
        ? {
            ...sh.highlight,
            categories:
              sh.highlight.highlight_categories?.map((hc: any) => hc.category) || [],
          }
        : null,
    }))

    // ── Overlay pending offline writes ──

    let pendingActions: any[] = []
    try {
      pendingActions = await listReplayable()
    } catch {
      // Non-fatal; worst case the overlay is empty and the cache shows server truth.
    }

    const futureRows = applyPendingActions(futureServerRows, pendingActions, categories).filter(
      (h: any) => h.date > today
    )

    // ── Split the normal-load rows into today + catch-up ──
    //
    // Same logic as loadHighlights in the review page — kept in sync manually.
    // These rows are already post-overlay from the normal load.

    const todayRows = allRows
      .filter((h: any) => h.date === today)
      .sort(
        (a: any, b: any) =>
          (a.highlight?.text?.length || 0) - (b.highlight?.text?.length || 0)
      )

    const catchUpRows = allRows
      .filter((h: any) => h.date < today && h.rating === null)
      .sort((a: any, b: any) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1
        return (a.highlight?.text?.length || 0) - (b.highlight?.text?.length || 0)
      })

    // ── Reconcile frozen ahead order ──

    const { ids: serverIds, ok: serverOk } = await aheadOrderPromise
    let frozen = serverIds ?? readAheadOrder(userId, cycle.key)
    if (!frozen) {
      const legacy = readLegacyAheadOrder(userId, cycle.key)
      if (legacy) {
        const rowKey = new Map(futureRows.map((r: any) => [r.id, r.highlight_id]))
        const translated = legacy
          .map((id: string) => rowKey.get(id))
          .filter((k: any): k is string => !!k)
        if (translated.length > 0) frozen = translated
      }
    }

    const { ordered: aheadRows, frozenIds } = reconcileAheadOrder(
      futureRows,
      frozen,
      (h: any) => h.highlight?.text?.length || 0,
      (h: any) => h.highlight_id
    )

    // Persist the reconciled order so the actual ahead-mode load picks it up.
    writeAheadOrder(userId, cycle.key, frozenIds)
    if (serverOk && JSON.stringify(frozenIds) !== JSON.stringify(serverIds)) {
      storeAheadOrder(supabase, userId, cycle.key, frozenIds)
    }

    // ── Cache the full ahead-mode set ──

    const processed = [...todayRows, ...catchUpRows, ...aheadRows]

    await cacheReviewAheadData({
      highlights: processed,
      categories,
      pinnedHighlightIds: pinnedIds,
      cachedAt: Date.now(),
    })
  } catch (e) {
    // Background pre-load — never surface errors to the user.
    console.warn('Background ahead pre-load failed (non-fatal):', e)
  }
}
