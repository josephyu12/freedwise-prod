import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ error: null as any, reads: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }) },
  from: state.reads,
}) }))

it('treats a repeated pin as success, without consuming another pin slot', async () => {
  const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: 'pin' }, error: null }) }
  state.reads.mockReturnValue(q)
  const { POST } = await import('@/app/api/pins/route')
  const response = await POST({ json: async () => ({ highlightId: 'h1' }) } as any)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ alreadyPinned: true })
  expect(state.reads).toHaveBeenCalledTimes(1)
})
