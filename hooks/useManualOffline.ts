'use client'

import { useCallback, useEffect, useState } from 'react'

// User-controlled "stay offline" switch. Distinct from automatic connectivity
// detection (useOfflineStatus): this is the user explicitly opting out of all
// network sync — useful on a weak/flapping connection where the heartbeat would
// otherwise keep flipping online↔offline and trigger reloads mid-review.
//
// Persisted in localStorage so it survives the full-page navigations between
// /review, /daily, etc. Changes broadcast a window event so every mounted
// consumer (the header toggle, the banner, each page's useOfflineStatus, the
// global OfflineSync drainer) stays in sync within a single page load. A
// `storage` listener keeps multiple tabs consistent too.

const STORAGE_KEY = 'freedwise:manual-offline'
export const MANUAL_OFFLINE_EVENT = 'manual-offline-change'

export function readManualOffline(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeManualOffline(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, '1')
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage failures (private mode, quota) — the in-page event still
    // propagates the change for the current session.
  }
}

export function useManualOffline() {
  // Start false to match SSR (localStorage is unavailable on the server); the
  // mount effect reconciles to the real persisted value.
  const [manualOffline, setManualOffline] = useState(false)

  useEffect(() => {
    setManualOffline(readManualOffline())

    const onChange = () => setManualOffline(readManualOffline())
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setManualOffline(readManualOffline())
    }

    window.addEventListener(MANUAL_OFFLINE_EVENT, onChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(MANUAL_OFFLINE_EVENT, onChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setEnabled = useCallback((enabled: boolean) => {
    writeManualOffline(enabled)
    // Notify this tab's other consumers; the listener above updates local state.
    window.dispatchEvent(new CustomEvent(MANUAL_OFFLINE_EVENT, { detail: { enabled } }))
  }, [])

  return { manualOffline, setManualOffline: setEnabled }
}
