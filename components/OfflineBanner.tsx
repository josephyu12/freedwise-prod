'use client'

import Link from 'next/link'
import { useManualOffline } from '@/hooks/useManualOffline'

interface OfflineBannerProps {
  isOnline: boolean
  isSyncing?: boolean
  pendingCount?: number
  // True when the banner is mounted on /review/lite itself. The weak-signal
  // message normally offers a "Switch to text-only →" link, but that's a no-op
  // here (you're already there), so we drop the link and keep just the message.
  onLitePage?: boolean
}

export default function OfflineBanner({ isOnline, isSyncing, pendingCount, onLitePage }: OfflineBannerProps) {
  const { manualOffline, setManualOffline } = useManualOffline()

  // manualOffline is checked here too (not just via isOnline) so the banner
  // can't vanish if a page's isOnline state is stale — the manual switch is
  // the source of truth and must always show the banner while it's on.
  if (isOnline && !isSyncing && !manualOffline) return null

  // Detect weak signal: our heartbeat says offline but navigator thinks we're online
  const isWeakSignal = !isOnline && typeof navigator !== 'undefined' && navigator.onLine

  return (
    <div
      className={`w-full px-4 py-2 text-center text-sm font-medium transition-all duration-300 ${
        isSyncing && !manualOffline
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200'
          : 'bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200'
      }`}
    >
      {/* Manual offline wins over the syncing spinner: flipping the switch
          mid-drain must acknowledge the choice IMMEDIATELY, not after the
          in-flight replay settles — otherwise the banner keeps "syncing" for
          seconds after the user explicitly went offline. */}
      {manualOffline ? (
        <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <span>🔌 Offline mode is on — changes save on this device and won&apos;t sync.</span>
          <button
            onClick={() => setManualOffline(false)}
            className="underline font-semibold"
          >
            Go back online →
          </button>
        </span>
      ) : isSyncing ? (
        <span className="flex items-center justify-center gap-2">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Syncing {pendingCount ? `${pendingCount} pending` : ''} change{pendingCount !== 1 ? 's' : ''}…
        </span>
      ) : isWeakSignal ? (
        <span>
          📶 Weak connection — ratings will be saved and synced automatically.
          {!onLitePage && (
            <>
              {' '}
              <Link href="/review/lite" className="underline font-semibold">
                Switch to text-only →
              </Link>
            </>
          )}
        </span>
      ) : (
        <span>⚡ You&apos;re offline — ratings will sync when you reconnect</span>
      )}
    </div>
  )
}
