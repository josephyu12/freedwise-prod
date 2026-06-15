'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { useOfflineSyncState } from '@/hooks/useOfflineSyncState'
import OfflineBanner from '@/components/OfflineBanner'

// Offline status banner for the text-only review page. The actual replay of
// queued ratings is owned by the global <OfflineSync> in the root layout, so it
// happens on reconnect from any page — not just here. When a sync finishes we
// refresh the route so the server-rendered list reflects the now-persisted
// ratings.
export default function LiteOfflineSync() {
  const { isOnline } = useOfflineStatus()
  const { isSyncing, pendingCount } = useOfflineSyncState()
  const router = useRouter()

  useEffect(() => {
    const onComplete = (e: Event) => {
      const result = (e as CustomEvent).detail
      if (result?.processed > 0) router.refresh()
    }
    window.addEventListener('offline-sync-complete', onComplete)
    return () => window.removeEventListener('offline-sync-complete', onComplete)
  }, [router])

  return (
    <>
      <OfflineBanner isOnline={isOnline} isSyncing={isSyncing} pendingCount={pendingCount} onLitePage />
      {!isOnline && pendingCount > 0 && (
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          {pendingCount} change{pendingCount === 1 ? '' : 's'} saved on this device — will sync when you reconnect.
        </p>
      )}
    </>
  )
}
