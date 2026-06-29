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

import { getPendingActions, removeAction, incrementActionAttempts } from './offlineStore'
import { isEffectivelyOffline } from '@/hooks/useManualOffline'
import { callRedistribute } from './redistribute'
import { removeFromFutureMonths } from './removeFromFutureMonths'
import { getUserFrequency, getCycleForDate, prevCycle, cycleKeyForDate } from './cycle'
import { recordDiscardedChange, describeDiscardedAction } from './discardedChanges'

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

// A "poison" action — one the SERVER keeps rejecting (an orphaned row, a
// constraint it can never satisfy, an RLS denial) — is dropped after this many
// failed attempts so it stops blocking everything queued behind it forever.
const MAX_ATTEMPTS = 5

// Only a server-side rejection counts toward the poison threshold. A thrown
// Supabase error carries a PostgREST/Postgres code; a transient network failure
// (fetch threw, request aborted/timed out) does not. Counting only coded errors
// keeps the long-standing data-safety guarantee intact: a flaky connection never
// burns down a perfectly good action's attempt budget — only a write the server
// actively refuses does. Unknown/codeless errors are treated as transient (the
// safe default: retry, never drop).
function isPermanentError(err: any): boolean {
  return !!(err && typeof err === 'object' && typeof err.code === 'string' && err.code.length > 0)
}

export interface ReplayResult {
  processed: number // actions successfully synced this run
  remaining: number // replayable actions still queued afterward
  touchedHighlights: boolean // whether any highlight content changed
  stalled: boolean // stopped with work left (likely transient failure)
  dropped: number // poison actions discarded this run (server kept rejecting them)
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

export interface DrainHooks {
  onStart?: (pending: number) => void
  onProgress?: (remaining: number) => void
  onComplete?: (result: ReplayResult) => void
}

// Module-level single-flight guard for the drain, shared by every caller (the
// global <OfflineSync> AND page loads that drain before reading the server). A
// caller arriving while a drain is in flight JOINS that drain's promise and
// marks it dirty, so the running drain loops once more to pick up anything
// queued meanwhile — it never starts a second overlapping drain over the same
// queue snapshot.
let drainPromise: Promise<ReplayResult | null> | null = null
let drainDirty = false

/**
 * Drain the offline queue once, end to end, behind a process-wide single-flight
 * guard. Returns the last ReplayResult, or null if nothing was drained (offline,
 * or queue empty). Hooks belong to the FIRST caller of an in-flight drain;
 * callers that join an existing drain pass no hooks. The global <OfflineSync>
 * uses the hooks to broadcast its window events; page loads await it hook-less
 * so they can read fresh server truth only after queued writes have landed.
 */
export function drainOfflineQueue(supabase: any, hooks: DrainHooks = {}): Promise<ReplayResult | null> {
  if (drainPromise) {
    drainDirty = true
    return drainPromise
  }
  if (isEffectivelyOffline()) return Promise.resolve(null)
  drainPromise = (async () => {
    let last: ReplayResult | null = null
    do {
      // Clear before each pass: a trigger arriving during this pass sets it
      // again, so we loop and pick up work enqueued mid-drain.
      drainDirty = false
      const pending = await countReplayable()
      if (pending === 0) break
      hooks.onStart?.(pending)
      last = await replayPendingActions(supabase, hooks.onProgress)
      hooks.onComplete?.(last)
      // Stop if the pass stalled on a transient failure: re-looping would just
      // re-hit the same blocked action at the front of the queue. The next real
      // trigger (reconnect / enqueue / page load) retries it. Anything queued
      // mid-drain is behind that action anyway, so nothing is lost by waiting.
      if (last.stalled) break
    } while (drainDirty && !isEffectivelyOffline())
    return last
  })().finally(() => {
    drainPromise = null
  })
  return drainPromise
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
    return { processed: 0, remaining, touchedHighlights: false, stalled: remaining > 0, dropped: 0 }
  }

  // Guard the mount race / offline state: if we're effectively offline — the
  // browser reports no connection OR the user flipped the manual switch — bail
  // before any removeAction so we never empty the queue against a connection
  // we're meant to ignore. The real reconnect (or toggling the switch off)
  // re-runs this. Defense in depth: <OfflineSync> already gates on this, but
  // replay must be self-protecting in case it's ever called from elsewhere.
  if (isEffectivelyOffline()) return idle()

  // RLS needs an authenticated user; if signed out, leave the queue untouched.
  let userId: string | undefined
  try {
    const { data } = await supabase.auth.getUser()
    userId = data?.user?.id
  } catch {
    /* treated as no user */
  }
  if (!userId) return idle()

  // The user's cadence drives the ledger key + auto-archive window for rating
  // replays (cycles, not bare months — identical when frequency = 1).
  let freq = 1
  try {
    freq = await getUserFrequency(supabase, userId)
  } catch {
    /* default monthly */
  }

  const all = await getPendingActions()
  const actions = all.filter((a) => REPLAYABLE.has(a.type))

  let processed = 0
  let dropped = 0
  let touchedHighlights = false
  let stalled = false

  for (const action of actions) {
    try {
      const touched = await replayOne(supabase, action, userId, freq)
      if (touched) touchedHighlights = true
      await removeAction(action.id!)
      processed++
      onProgress?.(actions.length - processed - dropped)
    } catch (err) {
      // A server rejection (coded error) advances this action's persistent
      // attempt count; once it crosses MAX_ATTEMPTS we give up on it and DROP it
      // so it can't block the rest of the queue forever, then continue past it.
      // A transient/network error (no code) never advances the count — we leave
      // the action and everything after it queued and stop, exactly as before,
      // for a real retry on the next drain. Either way nothing good is ever lost.
      if (isPermanentError(err)) {
        const attempts = await incrementActionAttempts(action.id!)
        if (attempts >= MAX_ATTEMPTS) {
          console.error(
            `Dropping poison offline action after ${attempts} server rejections:`,
            action,
            err
          )
          // Persist a user-facing notice BEFORE removing it — the change is about
          // to be lost for good, so the user must be told what didn't save.
          recordDiscardedChange({
            id: action.id!,
            type: action.type,
            label: describeDiscardedAction(action),
            at: Date.now(),
          })
          await removeAction(action.id!)
          dropped++
          onProgress?.(actions.length - processed - dropped)
          continue
        }
      }
      console.error('Offline replay failed; leaving action queued for retry:', err)
      stalled = true
      break
    }
  }

  if ((touchedHighlights || dropped > 0) && typeof window !== 'undefined') {
    // Nudge the Notion sync badge to refetch (the queue row itself was written
    // atomically by a DB trigger on the highlight write). Also refetch after a
    // drop: discarding a poison highlight write means the badge's optimistic
    // count no longer matches reality.
    window.dispatchEvent(new Event('notion-sync-queue-updated'))
  }

  const remaining = await countReplayable()
  return { processed, remaining, touchedHighlights, stalled, dropped }
}

// Replay a single action. Returns true if it changed highlight content (so the
// caller can refresh the Notion badge). Throws on any write/read failure.
async function replayOne(supabase: any, action: any, userId: string, freq: number): Promise<boolean> {
  switch (action.type) {
    case 'rate-review': {
      // Archive rule: low in BOTH this cycle and the previous one.
      const { summaryHighlightId, highlightId, rating, today: actionToday } = action.params
      const monthYear = cycleKeyForDate(actionToday, freq)

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
      const lowCycles = new Set(
        ((lowRatingsRes.data || []) as Array<{ rating: string; daily_summary: { date: string } }>)
          .filter((r) => !unarchivedAt || r.daily_summary.date > unarchivedAt)
          .map((r) => cycleKeyForDate(r.daily_summary.date, freq))
      )
      const prevKey = prevCycle(getCycleForDate(actionToday, freq)).key
      const shouldArchive = lowCycles.has(monthYear) && lowCycles.has(prevKey)

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
        const monthYear = cycleKeyForDate(summaryDate, freq)
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
