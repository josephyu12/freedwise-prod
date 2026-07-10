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
import { createClient } from './supabase/client'
import { isEffectivelyOffline } from '@/hooks/useManualOffline'
import { callRedistribute } from './redistribute'
import { removeFromFutureMonths } from './removeFromFutureMonths'
import { getUserFrequency, cycleKeyForDate } from './cycle'
import { updateHighlightStatsAfterRating } from './highlightStats'
import { removeReviewedOnClear } from './reviewedLedger'
import { recordDiscardedChange, describeDiscardedAction } from './discardedChanges'
import { reportError } from './reportError'

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

// The signed-in user's id from the LOCAL session (no network — works offline).
// undefined when signed out or when the client can't be constructed (tests).
async function currentUserIdLocal(): Promise<string | undefined> {
  try {
    const { data } = await createClient().auth.getSession()
    return data?.session?.user?.id ?? undefined
  } catch {
    return undefined
  }
}

// Whether a queued action belongs to `userId`. Unstamped actions (queued before
// owner-stamping existed) are treated as the current user's.
function ownedBy(action: { userId?: string }, userId: string | undefined): boolean {
  return !action.userId || (!!userId && action.userId === userId)
}

export interface ReplayResult {
  processed: number // actions successfully synced this run
  remaining: number // replayable actions still queued afterward
  touchedHighlights: boolean // whether any highlight content changed
  stalled: boolean // stopped with work left (likely transient failure)
  dropped: number // poison actions discarded this run (server kept rejecting them)
}

/** Count replayable actions still queued for the SIGNED-IN user (best-effort; 0 on error). */
export async function countReplayable(): Promise<number> {
  try {
    const all = await getPendingActions()
    const userId = await currentUserIdLocal()
    return all.filter((a) => REPLAYABLE.has(a.type) && ownedBy(a, userId)).length
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
  } catch (err) {
    // Can't know the cadence — replaying with a guessed monthly default would
    // write ledger rows under the wrong cycle key for freq>1 users. Leave the
    // whole queue for the next drain; a transient read failure heals itself.
    console.warn('Offline replay: failed to read review settings; will retry:', err)
    return idle()
  }

  const all = await getPendingActions()
  // Only the signed-in user's actions (plus legacy unstamped ones). Another
  // account's stamped actions are left queued untouched: replaying them here
  // would silently match zero rows under RLS (updates "succeed" and the queue
  // discards them) — or worse, a split replay would INSERT the other user's
  // text into this account. They resume when their owner signs back in.
  const actions = all.filter((a) => REPLAYABLE.has(a.type) && ownedBy(a, userId))

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
          reportError(err, {
            reason: 'poison offline action dropped',
            attempts,
            actionType: action.type,
          })
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
      reportError(err, { reason: 'offline replay stalled', actionType: action.type })
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
      const { summaryHighlightId, highlightId, rating, today: actionToday, summaryDate } = action.params
      // Key the ledger + archive window by the rated highlight's OWN day, not the
      // day the action was queued. Keying by `today` marked the wrong cycle when
      // rating catch-up/ahead across a cycle boundary (phantom ledger rows).
      // `summaryDate` is absent on actions queued before this fix — fall back to
      // `actionToday` so old queued ratings still replay.
      const ledgerDate = summaryDate || actionToday
      const monthYear = cycleKeyForDate(ledgerDate, freq)

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

      await updateHighlightStatsAfterRating(supabase, {
        highlightId,
        ratingDate: ledgerDate,
        freq,
      })
      return false
    }

    case 'rate-daily': {
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
      } else if (rating === null && summaryDate) {
        // Clearing a rating must also drop the cycle's "reviewed" checkmark (unless
        // another rated day remains in the cycle), or a phantom ledger row lingers.
        await removeReviewedOnClear(supabase, { userId, highlightId, summaryDate, freq })
      }

      // Shared stats + auto-archive rule (see lib/highlightStats.ts). Legacy
      // actions queued without summaryDate fall back to the local today.
      const n = new Date()
      const fallbackToday = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
      await updateHighlightStatsAfterRating(supabase, {
        highlightId,
        ratingDate: summaryDate || fallbackToday,
        freq,
      })
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
        // Idempotent per group: a retry after a partial replay re-sends ids that
        // already landed. A plain insert raised 23505 (a CODED error), which
        // burned the poison-attempt budget and eventually dropped the whole
        // action — permanently losing every not-yet-inserted group. ON CONFLICT
        // DO NOTHING (any unique constraint: the id PK on retry, or
        // (user_id, text_hash) when identical text already exists) makes the
        // retry glide past groups that are already in.
        const { data: upserted, error: insertError } = await supabase
          .from('highlights')
          .upsert(
            {
              id: group.id,
              text: group.text,
              html_content: group.html,
              source,
              author,
              resurface_count: 0,
              average_rating: 0,
              rating_count: 0,
              user_id: userId,
            },
            { ignoreDuplicates: true }
          )
          .select('id')
        if (insertError) throw insertError

        // Skipped upsert: either OUR row from a prior pass (id exists — finish
        // its follow-ups) or the text collided with an unrelated pre-existing
        // highlight (id absent — this split must not modify it).
        let exists = (upserted || []).length > 0
        if (!exists) {
          const { data: existing, error: existsError } = await supabase
            .from('highlights')
            .select('id')
            .eq('id', group.id)
            .maybeSingle()
          if (existsError) throw existsError
          exists = !!existing
        }
        if (!exists) continue

        insertedIds.push(group.id)

        if (categoryIds && categoryIds.length > 0) {
          const categoryLinks = (categoryIds as string[]).map((catId) => ({
            highlight_id: group.id,
            category_id: catId,
          }))
          // ignoreDuplicates so a retry that already linked them is a no-op.
          const { error: splitCatError } = await supabase
            .from('highlight_categories')
            .upsert(categoryLinks, { ignoreDuplicates: true })
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
      // Anchor unarchived_at at the moment the user ACTED, not the (possibly
      // days-later) replay — the auto-archive low-rating window starts here.
      const unarchivedAt = new Date(action.createdAt || Date.now()).toISOString()
      const { error: unarchiveError } = await supabase
        .from('highlights')
        .update({ archived: false, unarchived_at: unarchivedAt })
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
