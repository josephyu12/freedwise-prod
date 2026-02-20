'use client'

import { useState, useEffect, useCallback } from 'react'

/**
 * Hook that tracks online/offline status and exposes a manual re-check.
 * Returns { isOnline: boolean }
 */
export function useOfflineStatus() {
  const [isOnline, setIsOnline] = useState(true)

  useEffect(() => {
    // Set initial state (SSR-safe: default to true, correct on mount)
    setIsOnline(navigator.onLine)

    const goOnline = () => setIsOnline(true)
    const goOffline = () => setIsOnline(false)

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return { isOnline }
}
