'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  readManualOffline,
  MANUAL_OFFLINE_EVENT,
  MANUAL_OFFLINE_STORAGE_KEY,
} from './useManualOffline'

// Heartbeat cadence. This used to be a flat 15s always-on ping (~240 serverless
// invocations/hour/tab for a perfectly healthy connection). Now: a slow sanity
// check while online — weak-signal (connected Wi-Fi, dead internet) still gets
// detected within a minute, and every Supabase write is individually bounded by
// the client fetch timeout anyway — and fast probing only while offline, where
// quick recovery detection actually matters.
const HEARTBEAT_ONLINE_MS = 60_000
const HEARTBEAT_OFFLINE_MS = 15_000
const HEARTBEAT_TIMEOUT = 5_000 // timeout for the ping itself

/**
 * Hook that tracks online/offline status with real connectivity detection.
 *
 * Goes beyond navigator.onLine by pinging /api/health to detect cases where
 * Wi-Fi is connected but internet is unreachable (weak signal).
 *
 * Respects the user's manual "stay offline" switch (useManualOffline): while
 * that's on, this reports offline unconditionally and stops the heartbeat, so a
 * weak connection can't flap us back online and trigger a mid-review reload.
 *
 * Returns { isOnline: boolean }
 */
export function useOfflineStatus() {
  const [isOnline, setIsOnline] = useState(true)
  // The manual switch mirrored into React state. The heartbeat-interval effect
  // below keys on it: reading localStorage alone isn't enough, because flipping
  // the switch OFF while isOnline is already false changes neither dep — the
  // effect never re-ran and no interval was ever (re)armed, leaving the page
  // stuck "offline" on a connected-but-dead network with nothing left probing
  // for recovery.
  const [manualOffline, setManualOffline] = useState(false)
  // Monotonic id per checkConnectivity run: only the LATEST run may apply its
  // result, so a slow stale ping can't overwrite the state a newer run (or an
  // event handler) already set.
  const epochRef = useRef(0)

  const checkConnectivity = useCallback(async () => {
    // Manual offline always wins — never ping a connection the user has
    // explicitly opted out of.
    if (readManualOffline()) {
      setIsOnline(false)
      return
    }

    // No network for a hidden tab — the visibilitychange handler re-checks the
    // moment it's visible again.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return
    }

    // Fast path: if navigator says we're offline, trust it
    if (!navigator.onLine) {
      setIsOnline(false)
      return
    }

    const epoch = ++epochRef.current
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT)

      const response = await fetch('/api/health', {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      // A newer check started while this one was in flight — its result is the
      // fresher truth; discard this one.
      if (epoch !== epochRef.current) return

      // The world may have changed while this ping was in flight: the user may
      // have flipped the manual switch, or the browser may have lost the
      // connection. A stale "healthy" result must not stomp either back to
      // online (in manual mode nothing would ever correct it — the heartbeat
      // and the visibility/online handlers all stand down).
      if (readManualOffline() || !navigator.onLine) {
        setIsOnline(false)
        return
      }

      setIsOnline(response.ok)
    } catch {
      if (epoch !== epochRef.current) return
      // Fetch failed (network error, timeout, abort) — we're effectively offline
      setIsOnline(false)
    }
  }, [])

  // The heartbeat interval, keyed on connection state: slow sanity check while
  // online, fast recovery probing while offline. checkConnectivity itself
  // no-ops for hidden tabs and while manually offline. Keyed on manualOffline
  // STATE (not a readManualOffline() call) so flipping the switch off re-arms
  // the interval even when isOnline doesn't change value.
  useEffect(() => {
    if (manualOffline || readManualOffline()) return
    const period = isOnline ? HEARTBEAT_ONLINE_MS : HEARTBEAT_OFFLINE_MS
    const id = setInterval(checkConnectivity, period)
    return () => clearInterval(id)
  }, [isOnline, manualOffline, checkConnectivity])

  useEffect(() => {
    // Initial state from the manual switch, then navigator, refined by the
    // immediate check below.
    setManualOffline(readManualOffline())
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

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !readManualOffline()) {
        checkConnectivity()
      }
    }

    // React to the user toggling manual offline mode. Bumping the epoch first
    // invalidates any in-flight ping so its stale result can't land after this.
    const handleManualChange = () => {
      epochRef.current++
      setManualOffline(readManualOffline())
      if (readManualOffline()) {
        setIsOnline(false)
      } else {
        // Resume detection immediately (drains any queued offline writes once
        // connectivity is confirmed).
        checkConnectivity()
      }
    }

    // Manual offline toggled in ANOTHER tab: localStorage 'storage' events fire
    // here (MANUAL_OFFLINE_EVENT is same-tab only), so mirror them or this
    // tab's connectivity state silently diverges from the switch.
    const handleStorage = (e: StorageEvent) => {
      if (e.key === MANUAL_OFFLINE_STORAGE_KEY) handleManualChange()
    }

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener(MANUAL_OFFLINE_EVENT, handleManualChange)
    window.addEventListener('storage', handleStorage)

    // Immediate confirmation on mount.
    checkConnectivity()

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener(MANUAL_OFFLINE_EVENT, handleManualChange)
      window.removeEventListener('storage', handleStorage)
    }
  }, [checkConnectivity])

  return { isOnline }
}
