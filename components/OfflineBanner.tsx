'use client'

import { useState, useEffect } from 'react'
import { hasPendingActions } from '@/lib/offlineStore'

interface OfflineBannerProps {
  isOnline: boolean
  isSyncing?: boolean
  pendingCount?: number
}

export default function OfflineBanner({ isOnline, isSyncing, pendingCount }: OfflineBannerProps) {
  if (isOnline && !isSyncing) return null

  // Detect weak signal: our heartbeat says offline but navigator thinks we're online
  const isWeakSignal = !isOnline && typeof navigator !== 'undefined' && navigator.onLine

  return (
    <div
      className={`w-full px-4 py-2 text-center text-sm font-medium transition-all duration-300 ${
        isSyncing
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200'
          : 'bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200'
      }`}
    >
      {isSyncing ? (
        <span className="flex items-center justify-center gap-2">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Syncing {pendingCount ? `${pendingCount} pending` : ''} change{pendingCount !== 1 ? 's' : ''}…
        </span>
      ) : isWeakSignal ? (
        <span>📶 Weak connection — ratings will be saved and synced automatically</span>
      ) : (
        <span>⚡ You&apos;re offline — ratings will sync when you reconnect</span>
      )}
    </div>
  )
}
