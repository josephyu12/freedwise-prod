// @vitest-environment node
/**
 * Adversarial tests against the REAL @supabase/ssr client (no getUser mock).
 *
 * The mocked suite can hide two bugs:
 *  1. Anonymous getUser() returns AuthSessionMissingError, not { error: null }.
 *     Treating any error as fail-open disables the login redirect.
 *  2. withDeadline abandons getUser while auth-js is still in _refreshAccessToken's
 *     retryable loop (abort is AuthRetryableFetchError, backoff up to ~30s).
 *     Returning a Response while that loop is alive can keep the Edge isolate
 *     busy until Vercel's 25s kill — the original 504.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { MIDDLEWARE_GET_USER_DEADLINE_MS } from '@/lib/supabase/middleware'

const SUPABASE_URL = 'https://example.supabase.co'
const COOKIE_NAME = 'sb-example-auth-token'

function encodeSessionCookie(session: object) {
  const json = JSON.stringify(session)
  return 'base64-' + Buffer.from(json, 'utf8').toString('base64url')
}

function req(path: string, cookie?: { name: string; value: string }) {
  const headers = new Headers()
  if (cookie) headers.set('cookie', `${cookie.name}=${cookie.value}`)
  return new NextRequest(new URL(path, 'https://freedwise.vercel.app'), { headers })
}

function expiredSession() {
  return {
    access_token: 'header.payload.sig',
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
    expires_in: 3600,
    token_type: 'bearer',
  }
}

describe('middleware auth gate — real supabase client', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-anon-key-anon-key'
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('redirects anonymous visitors (AuthSessionMissingError, no cookies)', async () => {
    const { updateSession } = await import('@/lib/supabase/middleware')
    const res = await updateSession(req('/daily'))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!, 'https://freedwise.vercel.app').pathname).toBe(
      '/login'
    )
  })

  it('does not call Auth at all when there is no session', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as any
    const { updateSession } = await import('@/lib/supabase/middleware')
    await updateSession(req('/daily'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fail-opens an expired session whose refresh hangs, and STOPS the retry loop', async () => {
    const fetchStarts: number[] = []
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchStarts.push(Date.now())
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
          return
        }
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
        })
      })
    }) as typeof fetch

    const { updateSession } = await import('@/lib/supabase/middleware')
    const pending = updateSession(
      req('/daily', { name: COOKIE_NAME, value: encodeSessionCookie(expiredSession()) })
    )

    const res = await pending
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()

    const callsWhenResolved = fetchStarts.length
    expect(callsWhenResolved).toBeGreaterThan(0)

    await new Promise((r) => setTimeout(r, 1500))
    expect(fetchStarts.length).toBe(callsWhenResolved)

    // Deadline 401 makes auth-js _removeSession(); fail-open must not
    // forward those Set-Cookie deletions or a blip logs the user out.
    const setCookie = [
      ...(typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []),
      res.headers.get('set-cookie') ?? '',
    ].join('\n')
    expect(setCookie.toLowerCase()).not.toMatch(/max-age=0/)
    expect(setCookie).not.toMatch(/sb-example-auth-token=;/ )
  }, 15_000)

  it('settles well under Vercel\'s 25s kill with a hung expired-session refresh', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
        })
      })
    }) as typeof fetch

    const { updateSession } = await import('@/lib/supabase/middleware')
    const started = Date.now()
    await updateSession(
      req('/daily', { name: COOKIE_NAME, value: encodeSessionCookie(expiredSession()) })
    )
    expect(Date.now() - started).toBeLessThan(MIDDLEWARE_GET_USER_DEADLINE_MS + 3_000)
    expect(Date.now() - started).toBeLessThan(25_000)
  }, 15_000)
})
