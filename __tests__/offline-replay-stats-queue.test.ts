/**
 * After a rating lands, average_rating / rating_count used to run fire-and-forget
 * (and replay skipped stats failures). On a flaky connection the Med tap saved
 * but /highlights still showed "Avg Rating: —". Stats now queues a dedicated
 * `update-highlight-stats` retry that OfflineSync drains — without poison-dropping
 * the rating itself.
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
  enqueueHighlightStatsRetry: vi.fn(async (highlightId: string, ratingDate: string) => {
    const id = (state.queue.reduce((m, a) => Math.max(m, a.id || 0), 0) || 0) + 1
    state.queue.push({
      id,
      type: 'update-highlight-stats',
      params: { highlightId, ratingDate },
      createdAt: Date.now(),
    })
    return id
  }),
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
  offlineMocks.enqueueHighlightStatsRetry.mockClear()
  statsMock.updateHighlightStatsAfterRating.mockReset()
  statsMock.updateHighlightStatsAfterRating.mockResolvedValue({ archivedNow: false })
})

describe('offline post-rating stats queue', () => {
  it('queues update-highlight-stats when rate-review stats fail, and still drops the rating action', async () => {
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

    expect(offlineMocks.removeAction).toHaveBeenCalledWith(1)
    expect(offlineMocks.enqueueHighlightStatsRetry).toHaveBeenCalledWith('h1', '2026-08-12')
    expect(state.queue.map((a) => a.type)).toEqual(['update-highlight-stats'])
    expect(result.stalled).toBe(false)
  })

  it('retries update-highlight-stats on failure instead of skipping it', async () => {
    statsMock.updateHighlightStatsAfterRating.mockRejectedValueOnce(new Error('network blip'))
    state.queue = [
      {
        id: 7,
        type: 'update-highlight-stats',
        params: { highlightId: 'h1', ratingDate: '2026-08-12' },
        createdAt: 1,
      },
    ]

    const result = await replayPendingActions(makeSupabase())

    expect(offlineMocks.removeAction).not.toHaveBeenCalled()
    expect(state.queue).toHaveLength(1)
    expect(result.stalled).toBe(true)
  })

  it('drops update-highlight-stats once the average write lands', async () => {
    state.queue = [
      {
        id: 8,
        type: 'update-highlight-stats',
        params: { highlightId: 'h1', ratingDate: '2026-08-12' },
        createdAt: 1,
      },
    ]

    const result = await replayPendingActions(makeSupabase())

    expect(offlineMocks.removeAction).toHaveBeenCalledWith(8)
    expect(result.stalled).toBe(false)
    expect(statsMock.updateHighlightStatsAfterRating).toHaveBeenCalledWith(
      expect.anything(),
      { highlightId: 'h1', ratingDate: '2026-08-12', freq: 1 }
    )
  })
})
