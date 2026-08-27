// @vitest-environment node
/**
 * Session-gate unit tests with a mocked supabase client.
 *
 * Hung-fetch / retry-loop behavior is covered by the real-client suite
 * (__tests__/middleware-auth-gate-real-client.test.ts). These pin the
 * decision table: missing session redirects, retryable errors fail-open,
 * a present user passes through.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  MIDDLEWARE_FETCH_TIMEOUT_MS,
  MIDDLEWARE_GET_USER_DEADLINE_MS,
} from '@/lib/supabase/middleware'

const captured = vi.hoisted(() => ({
  options: null as any,
  getUser: vi.fn(),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: any) => {
    captured.options = options
    return { auth: { getUser: captured.getUser } }
  }),
}))

function req(path: string) {
  return new NextRequest(new URL(path, 'https://freedwise.vercel.app'))
}

async function updateSession() {
  const mod = await import('@/lib/supabase/middleware')
  return mod.updateSession
}

beforeEach(() => {
  captured.options = null
  captured.getUser.mockReset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
})

describe('middleware getUser — deadlines stay under the 25s kill', () => {
  it('keeps both bounds well under Vercel\'s middleware timeout', () => {
    expect(MIDDLEWARE_GET_USER_DEADLINE_MS).toBeLessThan(25_000)
    expect(MIDDLEWARE_FETCH_TIMEOUT_MS).toBeLessThan(MIDDLEWARE_GET_USER_DEADLINE_MS)
  })

  it('returns a response at the deadline even if getUser never settles', async () => {
    vi.useFakeTimers()
    captured.getUser.mockReturnValue(new Promise(() => {}))
    try {
      const run = await updateSession()
      const pending = run(req('/daily'))
      const outcome = expect(pending).resolves.toMatchObject({ status: 200 })
      await vi.advanceTimersByTimeAsync(MIDDLEWARE_GET_USER_DEADLINE_MS)
      await outcome
      expect((await pending).headers.get('location')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('middleware getUser — session gate', () => {
  it('redirects on AuthSessionMissingError (the real anonymous shape)', async () => {
    captured.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' },
    })
    const run = await updateSession()
    const res = await run(req('/daily'))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!, 'https://freedwise.vercel.app').pathname).toBe(
      '/login'
    )
  })

  it('redirects when user is null and error is null', async () => {
    captured.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const run = await updateSession()
    const res = await run(req('/daily'))
    expect(res.status).toBe(307)
  })

  it('lets a signed-in user through', async () => {
    captured.getUser.mockResolvedValue({
      data: { user: { id: 'u1' } },
      error: null,
    })
    const run = await updateSession()
    const res = await run(req('/daily'))
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it('fail-opens AuthRetryableFetchError rather than treating it as logged-out', async () => {
    captured.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'fetch failed' },
    })
    const run = await updateSession()
    const res = await run(req('/daily'))
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it('redirects on a dead session (AuthApiError 401), not fail-open', async () => {
    captured.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'invalid claim', status: 401 },
    })
    const run = await updateSession()
    const res = await run(req('/daily'))
    expect(res.status).toBe(307)
  })

  it('still allows /login through without a user', async () => {
    captured.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' },
    })
    const run = await updateSession()
    const res = await run(req('/login'))
    expect(res.status).toBe(200)
  })
})

describe('middleware fetch — AbortSignal timeout is injected', () => {
  it('passes an abort signal to the underlying fetch while getUser is in flight', async () => {
    const signals: AbortSignal[] = []
    const original = globalThis.fetch
    globalThis.fetch = vi.fn((_input: any, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal)
      return Promise.resolve(new Response('{}'))
    }) as any

    captured.getUser.mockImplementation(async () => {
      const wrapped = captured.options.global.fetch as typeof fetch
      await wrapped('https://example.supabase.co/auth/v1/user', {})
      expect(signals[0]).toBeInstanceOf(AbortSignal)
      expect(signals[0].aborted).toBe(false)
      return { data: { user: { id: 'u1' } }, error: null }
    })

    try {
      const run = await updateSession()
      await run(req('/daily'))
      expect(signals).toHaveLength(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
