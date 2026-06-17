/**
 * Regression tests for the manual "stay offline" switch.
 *
 * The bug this guards against: on a weak/flapping connection the heartbeat in
 * useOfflineStatus would ping /api/health, flip isOnline back true, and trigger
 * a sync that reloads the page mid-review. The manual switch (useManualOffline)
 * lets the user force offline so NO ping fires and isOnline stays false.
 *
 * Two invariants are tested:
 *   1. useManualOffline persists to localStorage and broadcasts the change so
 *      every mounted consumer in the same page sees it.
 *   2. useOfflineStatus reports offline AND never pings /api/health while the
 *      manual switch is on — that "never pings" is the whole point.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useManualOffline } from '@/hooks/useManualOffline'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'

beforeEach(() => {
  window.localStorage.clear()
  // Heartbeat would otherwise hit /api/health; spy so we can assert it is NOT
  // called while manually offline, and resolve ok when it is.
  global.fetch = vi.fn(async () => ({ ok: true } as Response)) as any
})

describe('useManualOffline', () => {
  it('persists the flag to localStorage and reads it back on a fresh mount', async () => {
    const first = renderHook(() => useManualOffline())
    expect(first.result.current.manualOffline).toBe(false)

    act(() => first.result.current.setManualOffline(true))
    await waitFor(() => expect(first.result.current.manualOffline).toBe(true))
    expect(window.localStorage.getItem('freedwise:manual-offline')).toBe('1')

    // A separately-mounted consumer (mirrors a different page/component) reads
    // the persisted value on mount.
    const second = renderHook(() => useManualOffline())
    await waitFor(() => expect(second.result.current.manualOffline).toBe(true))

    // Turning it off clears the key.
    act(() => first.result.current.setManualOffline(false))
    await waitFor(() => expect(first.result.current.manualOffline).toBe(false))
    expect(window.localStorage.getItem('freedwise:manual-offline')).toBeNull()
  })
})

describe('useOfflineStatus + manual offline', () => {
  it('reports offline and never pings /api/health while manually offline', async () => {
    // Pre-seed the manual flag so the hook starts offline on mount.
    window.localStorage.setItem('freedwise:manual-offline', '1')

    const { result } = renderHook(() => useOfflineStatus())

    await waitFor(() => expect(result.current.isOnline).toBe(false))

    // Give the heartbeat path a chance to run; it must stay silent.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('resumes connectivity checks once the manual switch is turned off', async () => {
    const manual = renderHook(() => useManualOffline())
    act(() => manual.result.current.setManualOffline(true))

    const status = renderHook(() => useOfflineStatus())
    await waitFor(() => expect(status.result.current.isOnline).toBe(false))

    // Flip back online — the heartbeat should resume and ping /api/health.
    act(() => manual.result.current.setManualOffline(false))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
  })
})
