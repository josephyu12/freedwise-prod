import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ client: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => state.client }))
vi.mock('@/lib/cycle', async (original) => ({ ...(await original<any>()), getUserReviewSettings: async () => ({ freq: 3, enabled: true }) }))

const rows = [
  { id: 'active', text: 'An idea', archived: false, months_reviewed: [{ id: 'ledger', month_year: '2026-10' }],
    daily_assignments: [{ rating: 'high', daily_summary: { date: '2026-11-02' } }],
    highlight_links_from: [], highlight_links_to: [{ id: 'link', from_highlight_id: 'other', from_highlight: { id: 'other', text: 'Related idea' } }] },
  { id: 'archived', text: 'An archived idea', archived: true },
]

beforeEach(() => {
  state.client = {
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) },
    rpc: vi.fn(async (_name, params) => ({ data: rows.filter((h) => params.include_archived || !h.archived).map((h) => ({ id: h.id, similarity: .9 })), error: null })),
    from: vi.fn(() => {
      let result = rows
      const q: any = {
        select: vi.fn(() => q), order: () => q, limit: () => q, or: () => q,
        eq: (key: string, value: unknown) => { if (key === 'archived') result = result.filter((h) => h.archived === value); return q },
        in: (_key: string, ids: string[]) => { result = result.filter((h) => ids.includes(h.id)); return q },
        then: (resolve: any) => resolve({ data: result, error: null }),
      }
      return q
    }),
  }
})

async function search(params: any) {
  const { POST } = await import('@/app/api/search/route')
  const response = await POST({ json: async () => ({ query: 'idea', type: 'semantic', embedding: Array(384).fill(.1), ...params }) } as any)
  expect(response.status).toBe(200)
  return response.json()
}

it('passes archive scope into ranking and keeps cycle-aware history / inbound links', async () => {
  const body = await search({ includeArchived: true })
  expect(body.results.map((h: any) => h.id)).toEqual(['active', 'archived'])
  expect(state.client.rpc).toHaveBeenCalledWith('search_highlights_hybrid_v2', expect.objectContaining({ include_archived: true }))
  expect(body.results[0].months_reviewed.map((m: any) => m.month_year)).toEqual(['2026-10'])
  expect(body.results[0].linked_highlights[0].to_highlight.id).toBe('other')
  expect(state.client.from.mock.results[0].value.select.mock.calls[0][0]).toContain('highlight_links_to')
})

it('excludes archives by default before ranking', async () => {
  const body = await search({})
  expect(body.results.map((h: any) => h.id)).toEqual(['active'])
  expect(state.client.rpc).toHaveBeenCalledWith('search_highlights_hybrid_v2', expect.objectContaining({ include_archived: false }))
})

it('honors archived scope with a disclosed keyword fallback on an older database', async () => {
  state.client.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
  const body = await search({ includeArchived: true })
  expect(body.fallback).toBe('keyword')
  expect(body.results.map((h: any) => h.id)).toEqual(['active', 'archived'])
  expect(state.client.rpc).toHaveBeenCalledTimes(1)
})

it('retains legacy hybrid search for active scope when only the new function is missing', async () => {
  state.client.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } })
  const body = await search({})
  expect(body.results.map((h: any) => h.id)).toEqual(['active'])
  expect(state.client.rpc.mock.calls[1][0]).toBe('search_highlights_hybrid')
})
