// @vitest-environment node
import 'next/dist/server/node-environment'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { AppRouteRouteModule } from 'next/dist/compiled/next-server/app-route.runtime.prod'
import * as widgetRoute from '@/app/api/review/widget/route'
import { createWidgetToken } from '@/lib/widgetToken'

const TODAY = '2026-11-14'
const USER = 'widget-user'
const DATABASE_URL = 'https://example.supabase.co'

// Exercise the real Next.js route wrapper, patched fetch, and Supabase client.
// A direct GET() call or mocked Supabase builder bypasses Next's Data Cache and
// cannot reproduce a dynamic response containing an old database snapshot.
function createRuntime() {
  const state = { reviewed: 1, tokenVersion: 1, enabled: true }
  const upstream = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== DATABASE_URL) throw new Error('Unexpected network destination')

    let data: unknown
    switch (url.pathname) {
      case '/rest/v1/user_widget_settings':
        data = [{ token_version: state.tokenVersion }]
        break
      case '/rest/v1/user_review_settings':
        data = [{ frequency_months: 1, daily_review_enabled: state.enabled }]
        break
      case '/rest/v1/daily_summary_highlights':
        data = Array.from({ length: 28 }, (_, i) => ({
          id: `row-${i}`, highlight_id: `highlight-${i}`,
          rating: i < state.reviewed ? 'high' : null,
          rated_at: i < state.reviewed ? new Date(Date.UTC(2026, 10, 14, 12, i)).toISOString() : null,
          daily_summary: { id: 'day', date: TODAY, user_id: USER },
          highlight: { id: `highlight-${i}`, text: 'x'.repeat(i + 1), archived: false, user_id: USER },
        }))
        break
      default:
        throw new Error(`Unexpected database table: ${url.pathname}`)
    }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', upstream)

  // This is only the persistent storage adapter. Next's real fetch code decides
  // whether to look up/cache/reuse a response; the test does not implement that
  // policy. Keep storage across requests, as the production Data Cache does.
  const entries = new Map<string, any>()
  const incrementalCache = {
    fetchCacheKey: async (url: string, init: RequestInit) => JSON.stringify([
      url, [...new Headers(init?.headers).entries()],
    ]),
    lock: async () => async () => {},
    get: async (key: string) => entries.has(key) ? { value: entries.get(key), isStale: false } : null,
    set: async (key: string, value: unknown) => { entries.set(key, value) },
    revalidateTag: async () => {},
  }
  const route = new AppRouteRouteModule({
    userland: widgetRoute,
    definition: {
      kind: 'APP_ROUTE', page: '/api/review/widget/route', pathname: '/api/review/widget',
      filename: 'route', bundlePath: 'app/api/review/widget/route',
    },
    resolvedPagePath: '/app/api/review/widget/route.ts',
    nextConfigOutput: undefined,
  } as any)
  const token = createWidgetToken(USER, 1)
  let nonce = 0
  const request = async () => {
    // The phone already cache-busts its HTTP requests. That must also result in
    // fresh server-side database reads, although those upstream URLs are stable.
    const url = new URL('https://widget.example/api/review/widget')
    url.searchParams.set('token', token)
    url.searchParams.set('date', TODAY)
    url.searchParams.set('_', String(++nonce))
    const context = {
      renderOpts: {
        supportsDynamicResponse: true, originalPathname: '/api/review/widget/route',
        experimental: { ppr: false }, incrementalCache,
      },
      prerenderManifest: { version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [], preview: {} },
    }
    const response = await route.handle(new NextRequest(url, {
      headers: { 'Cache-Control': 'no-cache' },
    }), context as any)
    await (context.renderOpts as any).waitUntil
    return { response, body: await response.json() }
  }
  return { state, upstream, request }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', DATABASE_URL)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')
  vi.stubEnv('WIDGET_TOKEN_SECRET', 'test-widget-signing-secret')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('widget freshness through the real Next.js route runtime', () => {
  it('advances from 1/28 to 9/28 when the saved ratings change between refreshes', async () => {
    const runtime = createRuntime()
    const first = await runtime.request()
    expect(first.response.status).toBe(200)
    expect(first.response.headers.get('cache-control')).toContain('no-store')
    expect(first.body).toMatchObject({ reviewed: 1, total: 28, highlight: { summaryHighlightId: 'row-1' } })

    runtime.state.reviewed = 9
    const refreshed = await runtime.request()
    expect(refreshed.response.status).toBe(200)
    expect(refreshed.body).toMatchObject({ reviewed: 9, total: 28, highlight: { summaryHighlightId: 'row-9' } })
  })

  it('checks the current token version after a previously successful refresh', async () => {
    const runtime = createRuntime()
    expect((await runtime.request()).response.status).toBe(200)
    runtime.state.tokenVersion = 2
    const revoked = await runtime.request()
    expect(revoked.response.status).toBe(401)
    expect(revoked.body).toMatchObject({ tokenExpired: true })
  })

  it('observes daily review being disabled after a previously successful refresh', async () => {
    const runtime = createRuntime()
    expect((await runtime.request()).body.reviewed).toBe(1)
    runtime.state.enabled = false
    expect((await runtime.request()).body).toMatchObject({ enabled: false, allDone: true, highlight: null })
  })
})
