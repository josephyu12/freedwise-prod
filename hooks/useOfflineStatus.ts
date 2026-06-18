'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { readManualOffline, MANUAL_OFFLINE_EVENT } from './useManualOffline'

const HEARTBEAT_INTERVAL = 15_000 // 15 seconds
const HEARTBEAT_TIMEOUT = 5_000  // 5 second timeout for the ping

/**
 * Hook that tracks online/offline status with real connectivity detection.
 *
 * Goes beyond navigator.onLine by periodically pinging /api/health to detect
 * cases where Wi-Fi is connected but internet is unreachable (weak signal).
 *
 * Respects the user's manual "stay offline" switch (useManualOffline): while
 * that's on, this reports offline unconditionally and stops the heartbeat, so a
 * weak connection can't flap us back online and trigger a mid-review reload.
 *
 * Returns { isOnline: boolean }
 */
export function useOfflineStatus() {
  const [isOnline, setIsOnline] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const checkConnectivity = useCallback(async () => {
    // Manual offline always wins — never ping a connection the user has
    // explicitly opted out of.
    if (readManualOffline()) {
      setIsOnline(false)
      return
    }

    // Fast path: if navigator says we're offline, trust it
    if (!navigator.onLine) {
      setIsOnline(false)
      return
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT)

      const response = await fetch('/api/health', {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      setIsOnline(response.ok)
    } catch {
      // Fetch failed (network error, timeout, abort) — we're effectively offline
      setIsOnline(false)
    }
  }, [])

  useEffect(() => {
    const startHeartbeat = () => {
      // Don't run the heartbeat while the user is manually offline.
      if (readManualOffline()) return
      if (!intervalRef.current) {
        checkConnectivity() // immediate check
        intervalRef.current = setInterval(checkConnectivity, HEARTBEAT_INTERVAL)
      }
    }
    const stopHeartbeat = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    // Set initial state based on the manual switch, then navigator (refined by
    // the first heartbeat).
    if (readManualOffline()) {
      setIsOnline(false)
    } else {
      setIsOnline(navigator.onLine)
    }

    const goOnline = () => {
      // Navigator says online — verify with a heartbeat immediately, unless the
      // user has chosen to stay offline.
      if (!readManualOffline()) checkConnectivity()
    }
    const goOffline = () => setIsOnline(false)

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        startHeartbeat()
      } else {
        stopHeartbeat()
      }
    }

    // React to the user toggling manual offline mode.
    const handleManualChange = () => {
      if (readManualOffline()) {
        stopHeartbeat()
        setIsOnline(false)
      } else if (document.visibilityState === 'visible') {
        // Resume detection immediately (drains any queued offline writes once
        // connectivity is confirmed).
        startHeartbeat()
      } else {
        checkConnectivity()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener(MANUAL_OFFLINE_EVENT, handleManualChange)

    // Start immediately if page is visible
    if (document.visibilityState === 'visible') {
      startHeartbeat()
    }

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener(MANUAL_OFFLINE_EVENT, handleManualChange)
      stopHeartbeat()
    }
  }, [checkConnectivity])

  return { isOnline }
}
