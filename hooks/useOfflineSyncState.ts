'use client'

import { useEffect, useState } from 'react'

// Subscribes to the global <OfflineSync> drainer's window events so any page's
// OfflineBanner can show "syncing N changes…" without owning the replay itself.
export function useOfflineSyncState() {
  const [isSyncing, setIsSyncing] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
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
