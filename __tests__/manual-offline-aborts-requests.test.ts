/**
 * Regression test for "rating hangs grayed out even after I turn on offline mode".
 *
 * A Supabase write that's mid-flight when the connection dies used to hang until
 * the client's 15s fetch timeout, keeping ratingInProgress (and the rating
 * buttons) locked — flipping the manual offline switch didn't help because
 * nothing aborted the in-flight request.
 *
 * The fix: lib/supabase/client.ts threads a shared abort signal into every
 * request and aborts it the moment MANUAL_OFFLINE_EVENT flips the switch on.
 * The hung write then rejects immediately and falls into its offline-queue
 * fallback. These tests capture the fetch wrapper passed to createBrowserClient
 * and assert the signal wiring directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const captured = vi.hoisted(() => ({ options: null as any }))

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: vi.fn((_url: string, _key: string, options: any) => {
    captured.options = options
    return {} as any
  }),
}))

const MANUAL_OFFLINE_KEY = 'freedwise:manual-offline'
const MANUAL_OFFLINE_EVENT = 'manual-offline-change'

const goManualOffline = () => {
  window.localStorage.setItem(MANUAL_OFFLINE_KEY, '1')
  window.dispatchEvent(new CustomEvent(MANUAL_OFFLINE_EVENT, { detail: { enabled: true } }))
}
const goBackOnline = () => {
  window.localStorage.removeItem(MANUAL_OFFLINE_KEY)
  window.dispatchEvent(new CustomEvent(MANUAL_OFFLINE_EVENT, { detail: { enabled: false } }))
}

// Records each request's signal; never settles — a dead-but-connected network.
const requestSignals: (AbortSignal | undefined)[] = []

// Fresh module per test: client.ts keeps the shared AbortController and its
// event listener in module state, which must not bleed between tests.
async function wrappedFetch(): Promise<(input: any, init?: any) => Promise<any>> {
  vi.resetModules()
  const { createClient } = await import('@/lib/supabase/client')
  createClient()
  return captured.options.global.fetch
}

beforeEach(() => {
  window.localStorage.clear()
  requestSignals.length = 0
  captured.options = null
  global.fetch = vi.fn((_input: any, init?: any) => {
    requestSignals.push(init?.signal)
    return new Promise(() => {}) as any
  }) as any
})

describe('supabase client — manual offline aborts requests', () => {
  it('aborts an in-flight request the moment manual offline turns on', async () => {
    const doFetch = await wrappedFetch()

    doFetch('https://example.supabase.co/rest/v1/x', {})
    const signal = requestSignals[0]!
    expect(signal.aborted).toBe(false)

    goManualOffline()
    expect(signal.aborted).toBe(true)
  })

  it('rejects a new request immediately while manually offline', async () => {
    const doFetch = await wrappedFetch()
    goManualOffline()

    doFetch('https://example.supabase.co/rest/v1/x', {})
    expect(requestSignals[0]!.aborted).toBe(true)
  })

  it('requests get a live signal again after going back online', async () => {
    const doFetch = await wrappedFetch()
    goManualOffline()
    goBackOnline()

    doFetch('https://example.supabase.co/rest/v1/x', {})
    expect(requestSignals[0]!.aborted).toBe(false)
  })

  it('still bounds requests with the 15s timeout when online', async () => {
    vi.useFakeTimers()
    try {
      const doFetch = await wrappedFetch()

      doFetch('https://example.supabase.co/rest/v1/x', {})
      const signal = requestSignals[0]!
      expect(signal.aborted).toBe(false)

      vi.advanceTimersByTime(15_000)
      expect(signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
