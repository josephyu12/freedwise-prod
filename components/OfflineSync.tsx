'use client'

import { useCallback, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { isEffectivelyOffline } from '@/hooks/useManualOffline'
import { replayPendingActions, countReplayable } from '@/lib/offlineReplay'

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
  const inFlight = useRef(false)

  const runSync = useCallback(async () => {
    // Single-flight: a flapping connection (or a burst of enqueues) must not run
    // two overlapping replays over the same queue snapshot.
    if (inFlight.current) return
    // Offline (manual switch OR a real disconnect) means do not drain. The
    // manual case matters most: the user opted out of sync typically BECAUSE
    // they still have a (weak/flapping) connection, so navigator.onLine is
    // usually true. Without this, every queued rating would fire
    // `offline-action-enqueued` → drain immediately → `offline-sync-complete` →
    // a page reload after each rating, which is exactly what offline mode is
    // meant to prevent.
    if (isEffectivelyOffline()) return
    inFlight.current = true
    try {
      const pending = await countReplayable()
      if (pending === 0) return
      window.dispatchEvent(new CustomEvent('offline-sync-start', { detail: { pending } }))
      const result = await replayPendingActions(supabaseRef.current, (remaining) => {
        window.dispatchEvent(new CustomEvent('offline-sync-progress', { detail: { remaining } }))
      })
      window.dispatchEvent(new CustomEvent('offline-sync-complete', { detail: result }))
    } finally {
      inFlight.current = false
    }
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
