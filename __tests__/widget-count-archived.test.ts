import { beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'

const SECRET = 'test-service-role-key'
const TODAY = '2026-11-02'
const state = vi.hoisted(() => ({ rows: [] as any[], error: null as any, filters: [] as any[] }))

function row(id: string, text: string, extra: any = {}) {
  return { id, highlight_id: `h-${id}`, rating: null, rated_at: null,
    daily_summary: { id: 'day', date: TODAY, user_id: 'user-1' },
    highlight: { id: `h-${id}`, text, archived: false, user_id: 'user-1' }, ...extra }
}
function value(row: any, column: string) { return column.split('.').reduce((v, k) => v?.[k], row) }
function makeClient() {
  return { from: (table: string) => {
    const filters: any[] = []
    let start = 0, end = 999
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { filters.push(['eq', c, v]); state.filters.push(['eq', c, v]); return q },
      gte: (c: string, v: any) => { filters.push(['gte', c, v]); return q },
      lte: (c: string, v: any) => { filters.push(['lte', c, v]); return q },
      lt: (c: string, v: any) => { filters.push(['lt', c, v]); return q },
      order: () => q,
      range: (a: number, b: number) => { start = a; end = b; return q },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) => {
        if (table !== 'daily_summary_highlights') return resolve({ data: [], error: null })
        const rows = state.rows.filter((r) => filters.every(([op, c, v]) =>
          op === 'eq' ? value(r, c) === v : op === 'gte' ? value(r, c) >= v : op === 'lt' ? value(r, c) < v : value(r, c) <= v))
        return resolve({ data: rows.slice(start, end + 1), error: state.error })
      },
    }
    return q
  } }
}
vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }))

async function widget() {
  const expiry = String(Date.now() + 60_000)
  const sig = crypto.createHmac('sha256', SECRET).update(`user-1.${expiry}`).digest('hex')
  const token = `user-1.${expiry}.${sig}`
  const { GET } = await import('@/app/api/review/widget/route')
  return GET({ nextUrl: new URL(`http://localhost/api/review/widget?token=${token}&date=${TODAY}`) } as any)
}
beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  state.filters = []; state.error = null; state.rows = []
})

describe('widget progress and resume', () => {
  it('reports 45/45 when only an archived, unrated row remains', async () => {
    state.rows = Array.from({ length: 45 }, (_, i) => row(`r${i}`, 'Reviewed', { rating: 'high' }))
    state.rows.push(row('archived', 'Hidden', { highlight: { text: 'Hidden', archived: true, user_id: 'user-1' } }))
    expect(await (await widget()).json()).toMatchObject({ total: 45, reviewed: 45, allDone: true, highlight: null })
  })

  it('continues after the latest rated card, instead of the first skipped card', async () => {
    state.rows = [row('a', 'A'), row('b', 'BB', { rating: 'med', rated_at: '2026-11-02T14:00:00Z' }), row('c', 'CCC')]
    const response = await widget()
    expect(await response.json()).toMatchObject({ total: 3, reviewed: 1, highlight: { summaryHighlightId: 'c' } })
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('never selects another user’s rows or future review-ahead cards', async () => {
    state.rows = [row('today', 'Today'),
      row('tomorrow', 'X', { daily_summary: { date: '2026-11-03', user_id: 'user-1' } }),
      row('foreign', 'Y', { daily_summary: { date: TODAY, user_id: 'other' } })]
    expect(await (await widget()).json()).toMatchObject({ total: 1, highlight: { summaryHighlightId: 'today' } })
    expect(state.filters).toContainEqual(['eq', 'daily_summary.user_id', 'user-1'])
    expect(state.filters).toContainEqual(['eq', 'highlight.user_id', 'user-1'])
  })

  it('continues catch-up when there is no summary today', async () => {
    state.rows = [row('catch-up', 'Earlier', { daily_summary: { date: '2026-11-01', user_id: 'user-1' } })]
    expect(await (await widget()).json()).toMatchObject({ total: 0, reviewed: 0, catchUpDate: '2026-11-01', highlight: { summaryHighlightId: 'catch-up' } })
  })

  it('loads beyond the default 1000-row cap', async () => {
    state.rows = Array.from({ length: 1000 }, (_, i) => row(`rated-${i}`, 'Rated', { rating: 'high' }))
    state.rows.push(row('last', 'Last unrated'))
    expect(await (await widget()).json()).toMatchObject({ total: 1001, reviewed: 1000, highlight: { summaryHighlightId: 'last' } })
  })
})
