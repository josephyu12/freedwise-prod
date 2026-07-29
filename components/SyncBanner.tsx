'use client'

import { usePathname } from 'next/navigation'
import OfflineBanner from '@/components/OfflineBanner'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { useOfflineSyncState } from '@/hooks/useOfflineSyncState'

// The offline/syncing banner, mounted once in the root layout next to the
// global <OfflineSync> drainer that feeds it.
//
// It used to be rendered per-page, which meant it only existed once a page had
// finished loading — so the moment it mattered most (a cold load with queued
// highlights draining, where /review shows a bare "Loading..." for seconds)
// was exactly the moment nothing was on screen and the app looked frozen. The
// layout persists through route-level loading.tsx, Suspense fallbacks and each
// page's own `if (loading)` return, so hoisting the banner here makes it visible
// during all of them, on every route.
export default function SyncBanner() {
  const pathname = usePathname()
  const { isOnline } = useOfflineStatus()
  const { isSyncing, pendingCount } = useOfflineSyncState()

  return (
    <OfflineBanner
      isOnline={isOnline}
      isSyncing={isSyncing}
      pendingCount={pendingCount}
      onLitePage={pathname?.startsWith('/review/lite') ?? false}
    />
  )
}
