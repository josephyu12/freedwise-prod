/**
 * The average_rating write is part of the same rate-review / rate-daily action.
 * If it fails on a flaky connection, that one queued rating stays pending and
 * retries — we must not skip stats (old fire-and-forget) or enqueue a second
 * "updating average" change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({ queue: [] as any[] }))

const statsMock = vi.hoisted(() => ({
  updateHighlightStatsAfterRating: vi.fn(async () => ({ archivedNow: false })),
}))

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => state.queue.slice()),
  removeAction: vi.fn(async (id: number) => {
    state.queue = state.queue.filter((a) => a.id !== id)
  }),
  incrementActionAttempts: vi.fn(async () => 1),
  rememberUserId: vi.fn(),
}))

vi.mock('@/lib/offlineStore', () => offlineMocks)
vi.mock('@/lib/highlightStats', () => statsMock)
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))
vi.mock('@/lib/removeFromFutureMonths', () => ({ removeFromFutureMonths: vi.fn(async () => {}) }))
vi.mock('@/lib/cycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cycle')>()
  return { ...actual, getUserFrequency: vi.fn(async () => 1) }
})

import { replayPendingActions } from '@/lib/offlineReplay'

function makeSupabase() {
  const chain = (result: any): any => ({
    select: () => chain(result),
    update: () => chain(result),
    upsert: () => chain(result),
    eq: () => chain(result),
    or: () => chain(result),
    not: () => chain(result),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    then: (resolve: any) => resolve(result),
  })
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: () => chain({ data: [{ id: 'sh1', rating: 'med', rated_at: '2026-08-12T00:00:00.000Z' }], error: null }),
  } as any
}

beforeEach(() => {
  state.queue = []
  offlineMocks.removeAction.mockClear()
  statsMock.updateHighlightStatsAfterRating.mockReset()
  statsMock.updateHighlightStatsAfterRating.mockResolvedValue({ archivedNow: false })
})

describe('offline rating includes average update', () => {
  it('keeps the rate-review queued when stats fail, instead of skipping the average', async () => {
    statsMock.updateHighlightStatsAfterRating.mockRejectedValueOnce(new Error('network blip'))
    state.queue = [
      {
        id: 1,
        type: 'rate-review',
        params: {
          summaryHighlightId: 'sh1',
          highlightId: 'h1',
          rating: 'med',
          today: '2026-08-12',
          summaryDate: '2026-08-12',
        },
        createdAt: 1,
      },
    ]

    const result = await replayPendingActions(makeSupabase())

    expect(offlineMocks.removeAction).not.toHaveBeenCalled()
    expect(state.queue).toHaveLength(1)
    expect(state.queue[0].type).toBe('rate-review')
    expect(result.stalled).toBe(true)
  })

  it('drops the rate-review only after rating, ledger, and average all land', async () => {
    state.queue = [
      {
        id: 2,
        type: 'rate-review',
        params: {
          summaryHighlightId: 'sh1',
          highlightId: 'h1',
          rating: 'med',
          today: '2026-08-12',
          summaryDate: '2026-08-12',
        },
        createdAt: 1,
      },
    ]

    const result = await replayPendingActions(makeSupabase())

    expect(offlineMocks.removeAction).toHaveBeenCalledWith(2)
    expect(result.stalled).toBe(false)
    expect(statsMock.updateHighlightStatsAfterRating).toHaveBeenCalledWith(
      expect.anything(),
      { highlightId: 'h1', ratingDate: '2026-08-12', freq: 1 }
    )
  })
})
