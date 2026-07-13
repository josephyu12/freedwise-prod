'use client'

import { useCallback, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { isEffectivelyOffline } from '@/hooks/useManualOffline'
import { drainOfflineQueue } from '@/lib/offlineReplay'

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
// instead of waiting for the next reconnect). It broadcasts window events so
// banners can show progress and pages can reload their view when sync finishes:
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
      onStart: (pending) =>
        window.dispatchEvent(new CustomEvent('offline-sync-start', { detail: { pending } })),
      onProgress: (remaining) =>
        window.dispatchEvent(new CustomEvent('offline-sync-progress', { detail: { remaining } })),
      onComplete: (result) => {
        window.dispatchEvent(new CustomEvent('offline-sync-complete', { detail: result }))
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
