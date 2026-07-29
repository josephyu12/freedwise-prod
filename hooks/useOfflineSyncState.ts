'use client'

import { useEffect, useState } from 'react'
import { getSyncSnapshot } from '@/lib/offlineReplay'

// Subscribes to the global <OfflineSync> drainer's window events so any page's
// OfflineBanner can show "syncing N changes…" without owning the replay itself.
//
// The window events are fire-and-forget, so subscribing alone isn't enough: a
// consumer that mounts while a drain is ALREADY running (the common case on a
// cold load, where the drain starts before the page finishes loading) missed
// `offline-sync-start` and would render nothing. So we also read the drain's
// live snapshot — on mount, and again inside the effect to cover a sync that
// started between render and subscribe.
export function useOfflineSyncState() {
  const [isSyncing, setIsSyncing] = useState(() => getSyncSnapshot().isSyncing)
  const [pendingCount, setPendingCount] = useState(() => getSyncSnapshot().pendingCount)

  useEffect(() => {
    const snapshot = getSyncSnapshot()
    setIsSyncing(snapshot.isSyncing)
    setPendingCount(snapshot.pendingCount)

    const onStart = (e: Event) => {
      setIsSyncing(true)
      setPendingCount((e as CustomEvent).detail?.pending ?? 0)
    }
    const onProgress = (e: Event) => {
      setPendingCount((e as CustomEvent).detail?.remaining ?? 0)
    }
    const onComplete = (e: Event) => {
      setIsSyncing(false)
      setPendingCount((e as CustomEvent).detail?.remaining ?? 0)
    }
    window.addEventListener('offline-sync-start', onStart)
    window.addEventListener('offline-sync-progress', onProgress)
    window.addEventListener('offline-sync-complete', onComplete)
    return () => {
      window.removeEventListener('offline-sync-start', onStart)
      window.removeEventListener('offline-sync-progress', onProgress)
      window.removeEventListener('offline-sync-complete', onComplete)
    }
  }, [])

  return { isSyncing, pendingCount }
}
