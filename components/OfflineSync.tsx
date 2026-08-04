'use client'

import { useCallback, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { isEffectivelyOffline } from '@/hooks/useManualOffline'
import { drainOfflineQueue } from '@/lib/offlineReplay'
import { rememberUserId } from '@/lib/offlineStore'

// A stalled drain (transient failure mid-queue) retries on this backoff. Without
// it, a one-off hiccup while the heartbeat still reports "online" left queued
// writes sitting invisibly until the next reconnect/enqueue/page load — on a
// long-lived tab, potentially forever. Bounded so a persistent stall (e.g.
// signed out with legacy actions queued) can't poll indefinitely; any real
// trigger resets the budget.
const STALL_RETRY_MS = 30_000
const STALL_RETRY_MAX = 5

// Global, headless offline-queue drainer. Mounted once in the root layout so the
// entire offline action queue replays from ANY page — not just /review and
// /daily. Pages keep their own optimistic-write + enqueue logic; this owns the
// draining. It runs on three triggers: reconnect (isOnline → true), app load,
// and whenever an action is enqueued (so a weak-signal failure retries promptly
// instead of waiting for the next reconnect). The drain broadcasts window events
// so banners can show progress and pages can reload their view when sync
// finishes — see `announce()` in lib/offlineReplay:
//   • offline-sync-start    { pending }
//   • offline-sync-progress { remaining }
//   • offline-sync-complete ReplayResult
export default function OfflineSync() {
  const { isOnline } = useOfflineStatus()
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null)
  if (!supabaseRef.current) supabaseRef.current = createClient()

  // Delegate to the shared, single-flight drain in lib/offlineReplay so this
  // global drainer and any page that drains-before-read go through ONE guard
  // (joining an in-flight drain, never overlapping it). The drain's
  // single-flight + dirty-reloop also guarantees an action enqueued mid-drain
  // (e.g. an edit made on a flapping connection while the reconnect drain is
  // still running) gets picked up in the same cycle instead of being swallowed
  // and sitting unsynced — which surfaced as "the edit didn't sync / I still see
  // the original highlight without its review".
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryCountRef = useRef(0)

  const runSync = useCallback(function runSync() {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    drainOfflineQueue(supabaseRef.current, {
      // The progress window events are broadcast by drainOfflineQueue itself
      // (for every drain, not just this one), so all that's left here is the
      // stall retry.
      onComplete: (result) => {
        // Transient stall with work left and we still believe we're online:
        // schedule a bounded retry so the queue doesn't sit until the next
        // reconnect/enqueue/navigation.
        if (
          result?.stalled &&
          !isEffectivelyOffline() &&
          retryCountRef.current < STALL_RETRY_MAX
        ) {
          retryCountRef.current++
          retryTimerRef.current = setTimeout(runSync, STALL_RETRY_MS)
        }
      },
    })
  }, [])

  // Drain on reconnect / initial load. A real trigger resets the stall-retry
  // budget — it's fresh evidence the connection is worth trying again.
  useEffect(() => {
    if (isOnline) {
      retryCountRef.current = 0
      runSync()
    }
  }, [isOnline, runSync])

  // Keep the offline queue's owner stamp available synchronously. Queue writes
  // must never call auth.getSession() themselves — offline that can block on a
  // doomed token refresh for tens of seconds (see enqueueOfflineAction) — so
  // this subscription is where the id comes from. onAuthStateChange fires
  // INITIAL_SESSION immediately on subscribe, priming it on every page load
  // without anything on the user's critical path waiting.
  useEffect(() => {
    const { data } = supabaseRef.current!.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        rememberUserId(null)
      } else if (session?.user?.id) {
        rememberUserId(session.user.id)
      }
      // A null session that ISN'T a sign-out (e.g. a token refresh that failed
      // because we're offline) leaves the remembered id alone — dropping it
      // there would strip the owner stamp from exactly the offline writes that
      // need it most.
    })
    return () => data.subscription.unsubscribe()
  }, [])

  // Drain when something is freshly queued (e.g. a weak-signal write that failed
  // while still online).
  useEffect(() => {
    const onEnqueued = () => {
      retryCountRef.current = 0
      runSync()
    }
    window.addEventListener('offline-action-enqueued', onEnqueued)
    return () => {
      window.removeEventListener('offline-action-enqueued', onEnqueued)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [runSync])

  return null
}
