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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useManualOffline, isEffectivelyOffline } from '@/hooks/useManualOffline'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'

beforeEach(() => {
  window.localStorage.clear()
  // Heartbeat would otherwise hit /api/health; spy so we can assert it is NOT
  // called while manually offline, and resolve ok when it is.
  global.fetch = vi.fn(async () => ({ ok: true } as Response)) as any
})

describe('isEffectivelyOffline — the system-wide source of truth', () => {
  // navigator.onLine is read-only; redefine it per-test so we can simulate a cut.
  const setNavigatorOnline = (value: boolean) => {
    Object.defineProperty(navigator, 'onLine', { value, configurable: true })
  }

  afterEach(() => setNavigatorOnline(true))

  it('is offline when the manual switch is on, even with a live connection', () => {
    setNavigatorOnline(true)
    window.localStorage.setItem('freedwise:manual-offline', '1')
    expect(isEffectivelyOffline()).toBe(true)
  })

  it('is offline when the browser reports a real cut, switch off', () => {
    setNavigatorOnline(false)
    expect(isEffectivelyOffline()).toBe(true)
  })

  it('is online only when both the switch is off AND the browser is connected', () => {
    setNavigatorOnline(true)
    expect(isEffectivelyOffline()).toBe(false)
  })
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

  it('stays offline when the switch flips on while a health ping is in flight', async () => {
    // The banner-flicker bug: a heartbeat ping starts (mount or 60s tick), the
    // user toggles manual offline, then the stale "healthy" response resolves
    // and stomped isOnline back to true — hiding the offline banner with
    // nothing left running to correct it.
    let resolvePing!: (r: Response) => void
    global.fetch = vi.fn(
      () => new Promise<Response>((resolve) => { resolvePing = resolve })
    ) as any

    const manual = renderHook(() => useManualOffline())
    const status = renderHook(() => useOfflineStatus())

    // Mount kicks off an immediate health check; it's now hanging in flight.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())

    // User flips the switch mid-flight — banner appears.
    act(() => manual.result.current.setManualOffline(true))
    await waitFor(() => expect(status.result.current.isOnline).toBe(false))

    // The stale ping resolves ok. It must NOT flip us back online.
    await act(async () => {
      resolvePing({ ok: true } as Response)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(status.result.current.isOnline).toBe(false)
  })

  it('re-arms the heartbeat when the switch turns off while the network is still dead', async () => {
    // The stuck-offline bug: with the switch ON no heartbeat interval runs.
    // Turning it OFF on a connected-but-dead network (navigator.onLine still
    // true, health ping failing) changed neither isOnline (false→false) nor
    // the old interval effect's deps — so no interval was ever re-armed and
    // NOTHING was left probing for recovery. The page stayed "offline" forever.
    vi.useFakeTimers()
    try {
      let healthy = false
      global.fetch = vi.fn(async () => {
        if (!healthy) throw new TypeError('network dead')
        return { ok: true } as Response
      }) as any

      window.localStorage.setItem('freedwise:manual-offline', '1')
      const manual = renderHook(() => useManualOffline())
      const status = renderHook(() => useOfflineStatus())
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(status.result.current.isOnline).toBe(false)

      // Switch off; the immediate re-check still fails — we stay offline.
      act(() => manual.result.current.setManualOffline(false))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(status.result.current.isOnline).toBe(false)

      // The network recovers. The re-armed offline heartbeat (15s cadence)
      // must notice — before the fix, no timer existed and this stayed false.
      healthy = true
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(status.result.current.isOnline).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
