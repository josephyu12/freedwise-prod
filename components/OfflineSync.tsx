'use client'

import { useCallback, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { drainOfflineQueue } from '@/lib/offlineReplay'

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
  const runSync = useCallback(() => {
    drainOfflineQueue(supabaseRef.current, {
      onStart: (pending) =>
        window.dispatchEvent(new CustomEvent('offline-sync-start', { detail: { pending } })),
      onProgress: (remaining) =>
        window.dispatchEvent(new CustomEvent('offline-sync-progress', { detail: { remaining } })),
      onComplete: (result) =>
        window.dispatchEvent(new CustomEvent('offline-sync-complete', { detail: result })),
    })
  }, [])

  // Drain on reconnect / initial load.
  useEffect(() => {
    if (isOnline) runSync()
  }, [isOnline, runSync])

  // Drain when something is freshly queued (e.g. a weak-signal write that failed
  // while still online).
  useEffect(() => {
    const onEnqueued = () => runSync()
    window.addEventListener('offline-action-enqueued', onEnqueued)
    return () => window.removeEventListener('offline-action-enqueued', onEnqueued)
  }, [runSync])

  return null
}
