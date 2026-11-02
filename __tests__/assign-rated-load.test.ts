import { expect, it, vi } from 'vitest'

const { client, pack } = vi.hoisted(() => ({ client: { value: null as any }, pack: vi.fn(() => []) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client.value }))
vi.mock('@/lib/binPack', () => ({ packIntoDates: pack }))
vi.mock('@/lib/cycle', async (original) => ({ ...(await original<any>()), getUserReviewSettings: async () => ({ freq: 1, enabled: true }) }))

it('balances new assignments against rated highlights even when their ledger is present', async () => {
  const data: Record<string, any[]> = {
    highlights: [{ id: 'reviewed', score: 800 }, { id: 'new', score: 100 }],
    highlight_months_reviewed: [{ highlight_id: 'reviewed' }],
    daily_summaries: [{ id: 'day', date: '2026-11-02' }],
    daily_summary_highlights: [
      { highlight_id: 'reviewed', daily_summary_id: 'day', rating: 'high', highlight: { score: 800 } },
      { highlight_id: 'archived-history', daily_summary_id: 'day', rating: 'low', highlight: { score: 200 } },
    ],
  }
  client.value = {
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }) },
    from: (table: string) => {
      const q: any = { then: (resolve: any) => resolve({ data: data[table], error: null }) }
      for (const key of ['select', 'eq', 'range', 'gte', 'lte', 'in', 'not']) q[key] = () => q
      return q
    },
    rpc: vi.fn(async () => ({ error: null })),
  }
  const { POST } = await import('@/app/api/daily/assign/route')
  const res = await POST({ json: async () => ({ year: 2026, month: 11, fromDate: '2026-11-02' }) } as any)
  expect(res.status).toBe(200)
  expect(pack.mock.calls[0][0]).toEqual([{ id: 'new', score: 100 }])
  expect(pack.mock.calls[0][3].get('2026-11-02')).toBe(1000)
})
