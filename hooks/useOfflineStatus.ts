'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

const HEARTBEAT_INTERVAL = 15_000 // 15 seconds
const HEARTBEAT_TIMEOUT = 5_000  // 5 second timeout for the ping

/**
 * Hook that tracks online/offline status with real connectivity detection.
 *
 * Goes beyond navigator.onLine by periodically pinging /api/health to detect
 * cases where Wi-Fi is connected but internet is unreachable (weak signal).
 *
 * Returns { isOnline: boolean }
 */
export function useOfflineStatus() {
  const [isOnline, setIsOnline] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const checkConnectivity = useCallback(async () => {
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
    // Set initial state based on navigator (will be refined by first heartbeat)
    setIsOnline(navigator.onLine)

    const goOnline = () => {
      // Navigator says online — verify with a heartbeat immediately
      checkConnectivity()
    }
    const goOffline = () => setIsOnline(false)

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    // Start heartbeat when visible, pause when hidden
    const startHeartbeat = () => {
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

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        startHeartbeat()
      } else {
        stopHeartbeat()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)

    // Start immediately if page is visible
    if (document.visibilityState === 'visible') {
      startHeartbeat()
    }

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', handleVisibility)
      stopHeartbeat()
    }
  }, [checkConnectivity])

  return { isOnline }
}
