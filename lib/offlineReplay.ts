// Single source of truth for replaying the offline action queue.
//
// Previously /review and /daily each had their own ~250-line copy of this loop,
// and /review/lite a third (rate-review only). They drifted (e.g. archive's
// future-month cleanup and unarchive's unarchived_at existed only in /review),
// and — the bug this fixes — the queue only drained on those pages: finish a
// review offline, leave to Home/Daily, reconnect there, and the queued ratings
// never synced. This module runs from one global <OfflineSync> in the layout,
// so the whole queue drains on reconnect from ANY page.
//
// Behavior is intentionally data-safe: every write checks the Supabase result
// error and throws (Supabase RESOLVES rather than rejecting on a dead network,
// so an unchecked write would silently no-op and then removeAction would drop
// it). On any failure we stop and leave that action — and everything after it —
// queued for the next retry. Nothing is ever dropped.

import { getPendingActions, removeAction } from './offlineStore'
import { callRedistribute } from './redistribute'
import { removeFromFutureMonths } from './removeFromFutureMonths'

const REPLAYABLE = new Set<string>([
  'rate-review',
  'rate-daily',
  'edit-highlight',
  'split-highlight',
  'archive-highlight',
  'unarchive-highlight',
  'delete-highlight',
  'pin-highlight',
  'unpin-highlight',
])

export interface ReplayResult {
  processed: number // actions successfully synced this run
  remaining: number // replayable actions still queued afterward
  touchedHighlights: boolean // whether any highlight content changed
  stalled: boolean // stopped with work left (likely transient failure)
}

/** Count replayable actions still queued (best-effort; 0 on error). */
export async function countReplayable(): Promise<number> {
  try {
    const all = await getPendingActions()
    return all.filter((a) => REPLAYABLE.has(a.type)).length
  } catch {
    return 0
  }
}

/**
 * Drain the offline queue against Supabase. Safe to call from anywhere; it
 * no-ops when offline or signed out, leaving the queue intact for a real retry.
 */
export async function replayPendingActions(
  supabase: any,
  onProgress?: (remaining: number) => void
): Promise<ReplayResult> {
  const idle = async (): Promise<ReplayResult> => {
    const remaining = await countReplayable()
    return { processed: 0, remaining, touchedHighlights: false, stalled: remaining > 0 }
  }

  // Guard the mount race / offline state: if the browser knows we're offline,
  // bail before any removeAction so we never empty the queue against a dead
  // network. The real reconnect re-runs this.
  if (typeof navigator !== 'undefined' && !navigator.onLine) return idle()

  // RLS needs an authenticated user; if signed out, leave the queue untouched.
  let userId: string | undefined
  try {
    const { data } = await supabase.auth.getUser()
    userId = data?.user?.id
  } catch {
    /* treated as no user */
  }
  if (!userId) return idle()

  const all = await getPendingActions()
  const actions = all.filter((a) => REPLAYABLE.has(a.type))

  let processed = 0
  let touchedHighlights = false
  let stalled = false

  for (const action of actions) {
    try {
      const touched = await replayOne(supabase, action, userId)
      if (touched) touchedHighlights = true
      await removeAction(action.id!)
      processed++
      onProgress?.(actions.length - processed)
    } catch (err) {
      // Transient (network) or permanently poison — either way keep this and the
      // rest queued and stop. Data-safe: never drops, may stall behind a poison
      // action until it's resolved (the accepted trade across the app).
      console.error('Offline replay failed; leaving action queued for retry:', err)
      stalled = true
      break
    }
  }

  if (touchedHighlights && typeof window !== 'undefined') {
    // Nudge the Notion sync badge to refetch (the queue row itself was written
    // atomically by a DB trigger on the highlight write).
    window.dispatchEvent(new Event('notion-sync-queue-updated'))
  }

  const remaining = await countReplayable()
  return { processed, remaining, touchedHighlights, stalled }
}

// Replay a single action. Returns true if it changed highlight content (so the
// caller can refresh the Notion badge). Throws on any write/read failure.
async function replayOne(supabase: any, action: any, userId: string): Promise<boolean> {
  switch (action.type) {
    case 'rate-review': {
      // Archive rule: low in BOTH this month and the previous one.
      const { summaryHighlightId, highlightId, rating, today: actionToday } = action.params
      const [y, mo] = actionToday.split('-').map(Number)
      const monthYear = `${y}-${String(mo).padStart(2, '0')}`

      const { error: rateError } = await supabase
        .from('daily_summary_highlights')
        .update({ rating })
        .eq('id', summaryHighlightId)
      if (rateError) throw rateError

      const { error: reviewedError } = await supabase
        .from('highlight_months_reviewed')
        .upsert(
          { highlight_id: highlightId, month_year: monthYear },
          { onConflict: 'highlight_id,month_year' }
        )
      if (reviewedError) throw reviewedError

      const [allRatingsRes, highlightRes, lowRatingsRes] = await Promise.all([
        supabase
          .from('daily_summary_highlights')
          .select('rating')
          .eq('highlight_id', highlightId)
          .not('rating', 'is', null),
        supabase.from('highlights').select('unarchived_at').eq('id', highlightId).single(),
        supabase
          .from('daily_summary_highlights')
          .select('rating, daily_summary:daily_summaries!inner(date)')
          .eq('highlight_id', highlightId)
          .eq('rating', 'low'),
      ])
      if (allRatingsRes.error) throw allRatingsRes.error
      if (highlightRes.error) throw highlightRes.error
      if (lowRatingsRes.error) throw lowRatingsRes.error

      const ratingMap: Record<string, number> = { low: 1, med: 2, high: 3 }
      const ratingValues = ((allRatingsRes.data || []) as Array<{ rating: string }>)
        .map((r) => ratingMap[r.rating] || 0)
        .filter((v) => v > 0)
      const average =
        ratingValues.length > 0 ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length : 0

      const unarchivedAt = (highlightRes.data as any)?.unarchived_at?.split('T')[0]
      const lowMonths = new Set(
        ((lowRatingsRes.data || []) as Array<{ rating: string; daily_summary: { date: string } }>)
          .filter((r) => !unarchivedAt || r.daily_summary.date > unarchivedAt)
          .map((r) => r.daily_summary.date.substring(0, 7))
      )
      const prevMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
      const shouldArchive = lowMonths.has(monthYear) && lowMonths.has(prevMonth)

      const { error: statsError } = await supabase
        .from('highlights')
        .update({
          average_rating: average,
          rating_count: ratingValues.length,
          ...(shouldArchive ? { archived: true } : {}),
        })
        .eq('id', highlightId)
      if (statsError) throw statsError
      return false
    }

    case 'rate-daily': {
      // Archive rule: low at least twice (within the unarchive window).
      const { summaryHighlightId, highlightId, rating, summaryDate } = action.params

      const { error: rateError } = await supabase
        .from('daily_summary_highlights')
        .update({ rating })
        .eq('id', summaryHighlightId)
      if (rateError) throw rateError

      if (rating !== null && summaryDate) {
        const [y, mo] = summaryDate.split('-').map(Number)
        const monthYear = `${y}-${String(mo).padStart(2, '0')}`
        const { error: reviewedError } = await supabase
          .from('highlight_months_reviewed')
          .upsert(
            { highlight_id: highlightId, month_year: monthYear },
            { onConflict: 'highlight_id,month_year' }
          )
        if (reviewedError) throw reviewedError
      }

      const { data: allRatingsData, error: allRatingsError } = await supabase
        .from('daily_summary_highlights')
        .select('rating')
        .eq('highlight_id', highlightId)
        .not('rating', 'is', null)
      if (allRatingsError) throw allRatingsError

      const allRatings = (allRatingsData || []) as Array<{ rating: string }>
      const ratingMap: Record<string, number> = { low: 1, med: 2, high: 3 }
      const ratingValues = allRatings.map((r) => ratingMap[r.rating] || 0).filter((v) => v > 0)
      const average =
        ratingValues.length > 0 ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length : 0

      const { data: highlightData, error: highlightError } = await supabase
        .from('highlights')
        .select('unarchived_at')
        .eq('id', highlightId)
        .single()
      if (highlightError) throw highlightError

      let lowRatingsCount = 0
      if (highlightData?.unarchived_at) {
        const { data: recentLowRatings, error: recentLowError } = await supabase
          .from('daily_summary_highlights')
          .select('rating, daily_summary:daily_summaries!inner(date)')
          .eq('highlight_id', highlightId)
          .eq('rating', 'low')
          .gt('daily_summary.date', highlightData.unarchived_at.split('T')[0])
        if (recentLowError) throw recentLowError
        lowRatingsCount = (recentLowRatings || []).length
      } else {
        lowRatingsCount = allRatings.filter((r) => r.rating === 'low').length
      }

      const shouldArchive = lowRatingsCount >= 2

      const { error: statsError } = await supabase
        .from('highlights')
        .update({
          average_rating: average,
          rating_count: ratingValues.length,
          ...(shouldArchive ? { archived: true } : {}),
        })
        .eq('id', highlightId)
      if (statsError) throw statsError
      return false
    }

    case 'edit-highlight': {
      const { highlightId, text, htmlContent, source, author, categoryIds, skipNotionSync } =
        action.params

      const { error: editError } = await supabase
        .from('highlights')
        .update({
          text,
          html_content: htmlContent,
          source,
          author,
          ...(skipNotionSync ? { notion_optout_marker: crypto.randomUUID() } : {}),
        })
        .eq('id', highlightId)
      if (editError) throw editError

      const { error: catDeleteError } = await supabase
        .from('highlight_categories')
        .delete()
        .eq('highlight_id', highlightId)
      if (catDeleteError) throw catDeleteError

      if (categoryIds && categoryIds.length > 0) {
        const categoryLinks = (categoryIds as string[]).map((catId) => ({
          highlight_id: highlightId,
          category_id: catId,
        }))
        const { error: catInsertError } = await supabase
          .from('highlight_categories')
          .insert(categoryLinks)
        if (catInsertError) throw catInsertError
      }
      return true
    }

    case 'split-highlight': {
      const { originalHighlightId, firstGroup, newGroups, source, author, categoryIds } =
        action.params

      const { error: firstGroupUpdateError } = await supabase
        .from('highlights')
        .update({ text: firstGroup.text, html_content: firstGroup.html })
        .eq('id', originalHighlightId)
      if (firstGroupUpdateError) throw firstGroupUpdateError

      const insertedIds: string[] = []
      for (const group of newGroups as Array<{ id: string; text: string; html: string }>) {
        const { data: newHighlight, error: insertError } = await supabase
          .from('highlights')
          .insert({
            id: group.id,
            text: group.text,
            html_content: group.html,
            source,
            author,
            resurface_count: 0,
            average_rating: 0,
            rating_count: 0,
            user_id: userId,
          })
          .select()
          .single()
        if (insertError) throw insertError

        insertedIds.push(newHighlight.id)

        if (categoryIds && categoryIds.length > 0) {
          const categoryLinks = (categoryIds as string[]).map((catId) => ({
            highlight_id: newHighlight.id,
            category_id: catId,
          }))
          const { error: splitCatError } = await supabase
            .from('highlight_categories')
            .insert(categoryLinks)
          if (splitCatError) throw splitCatError
        }
      }

      if (insertedIds.length > 0) {
        callRedistribute(insertedIds).catch(() => {})
      }
      return true
    }

    case 'archive-highlight': {
      const { highlightId } = action.params
      const { error: archiveError } = await supabase
        .from('highlights')
        .update({ archived: true })
        .eq('id', highlightId)
      if (archiveError) throw archiveError
      // Best-effort future-month cleanup; the archive flag above is the critical
      // write and is already persisted.
      await removeFromFutureMonths(supabase, highlightId)
      return true
    }

    case 'unarchive-highlight': {
      const { highlightId } = action.params
      const { error: unarchiveError } = await supabase
        .from('highlights')
        .update({ archived: false, unarchived_at: new Date().toISOString() })
        .eq('id', highlightId)
      if (unarchiveError) throw unarchiveError
      return true
    }

    case 'delete-highlight': {
      const { highlightId } = action.params
      const { error: deleteError } = await supabase
        .from('highlights')
        .delete()
        .eq('id', highlightId)
      if (deleteError) throw deleteError
      callRedistribute().catch(() => {})
      return true
    }

    case 'pin-highlight': {
      const { highlightId } = action.params
      const response = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlightId }),
      })
      if (!response.ok) {
        // Pin slot already full or highlight gone — drop (don't throw); the
        // post-sync reload re-derives the truthful pin set.
        const data = await response.json().catch(() => ({}))
        console.warn('Pin replay rejected, dropping action:', data)
      }
      return false
    }

    case 'unpin-highlight': {
      const { highlightId } = action.params
      await fetch(`/api/pins?highlightId=${highlightId}`, { method: 'DELETE' })
      return false
    }

    default:
      return false
  }
}
