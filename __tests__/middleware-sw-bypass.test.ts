/**
 * Regression: GET /sw.js was matching middleware and calling getUser(), so a
 * hung Auth fetch 504'd the service worker as well as the document (Vercel
 * logs, 2026-08-27). The worker script is public and must not wait on auth.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
}))

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: (...args: unknown[]) => mocks.updateSession(...args),
}))

function req(path: string) {
  return new NextRequest(new URL(path, 'https://freedwise.vercel.app'))
}

describe('middleware — public / cron paths skip getUser', () => {
  beforeEach(() => {
    mocks.updateSession.mockReset()
    mocks.updateSession.mockResolvedValue(new Response(null, { status: 200 }))
  })

  it('does not call updateSession for /sw.js', async () => {
    const { middleware } = await import('@/middleware')
    const res = await middleware(req('/sw.js'))
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
  })

  it('does not call updateSession for the cron prepare endpoint', async () => {
    const { middleware } = await import('@/middleware')
    await middleware(req('/api/daily/prepare-next-cycle'))
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('does not call updateSession for the widget API', async () => {
    const { middleware } = await import('@/middleware')
    await middleware(req('/api/review/widget'))
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('still runs updateSession for app pages', async () => {
    const { middleware } = await import('@/middleware')
    await middleware(req('/daily'))
    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
  })
})
