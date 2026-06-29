/**
 * Regression test for poison-action handling in the offline replay loop.
 *
 * Before: any failed action (transient OR permanent) left the whole queue
 * stalled behind it forever — a single un-replayable write (an orphaned row, a
 * constraint it can never satisfy) blocked every later edit/rating indefinitely.
 *
 * Now: a SERVER rejection (a Supabase error carrying a PostgREST/Postgres
 * `code`) advances the action's persistent attempt count and, once it crosses
 * MAX_ATTEMPTS (5), the action is DROPPED so the rest of the queue can proceed.
 * A TRANSIENT failure (network error, no `code`) is never counted and never
 * dropped — the queue stalls and retries on the next drain, exactly as before.
 * This guarantees a flaky connection can't burn down a good action's budget.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({
  queue: [] as any[],
  attempts: new Map<number, number>(),
}))

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => state.queue.slice()),
  removeAction: vi.fn(async (id: number) => {
    state.queue = state.queue.filter((a) => a.id !== id)
  }),
  incrementActionAttempts: vi.fn(async (id: number) => {
    const next = (state.attempts.get(id) || 0) + 1
    state.attempts.set(id, next)
    return next
  }),
}))

vi.mock('@/lib/offlineStore', () => offlineMocks)
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))
vi.mock('@/lib/removeFromFutureMonths', () => ({ removeFromFutureMonths: vi.fn(async () => {}) }))
// freq is irrelevant for archive/unpin actions; keep cycle helpers cheap.
vi.mock('@/lib/cycle', () => ({
  getUserFrequency: vi.fn(async () => 1),
  getCycleForDate: vi.fn(),
  prevCycle: vi.fn(),
  cycleKeyForDate: vi.fn(),
}))

import { replayPendingActions } from '@/lib/offlineReplay'
import { getDiscardedChanges } from '@/lib/discardedChanges'

// archive-highlight replays as highlights.update().eq(); make that update return
// the supplied result so a test can drive a coded (permanent) or codeless
// (transient) failure.
function makeSupabase(updateResult: { error: any }) {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => ({
      update: vi.fn(() => ({ eq: vi.fn(async () => updateResult) })),
    })),
  } as any
}

beforeEach(() => {
  state.attempts = new Map()
  offlineMocks.removeAction.mockClear()
  offlineMocks.incrementActionAttempts.mockClear()
  window.localStorage.clear() // discarded-change notices persist here
})

describe('offline replay — poison-action dropping', () => {
  it('drops a server-rejected action after MAX_ATTEMPTS and lets the queue proceed', async () => {
    state.queue = [
      { id: 1, type: 'archive-highlight', params: { highlightId: 'h1' }, createdAt: 1 },
      { id: 2, type: 'unpin-highlight', params: { highlightId: 'h2' }, createdAt: 2 },
    ]
    // A real Postgres FK-violation-shaped error: it has a `code`, so it's
    // treated as permanent.
    const supabase = makeSupabase({ error: { code: '23503', message: 'fk violation' } })
    // unpin (action 2) only hits fetch(); make it succeed so we can prove the
    // queue progressed past the dropped poison.
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) } as any)) as any

    // Drains 1-4: action 1 keeps failing under the threshold → stall, nothing
    // removed, action 2 never reached.
    for (let i = 1; i <= 4; i++) {
      const r = await replayPendingActions(supabase)
      expect(r.stalled).toBe(true)
      expect(r.dropped).toBe(0)
      expect(offlineMocks.removeAction).not.toHaveBeenCalled()
      expect(state.attempts.get(1)).toBe(i)
    }

    // Drain 5: attempt count hits MAX_ATTEMPTS → action 1 dropped, loop continues
    // and action 2 replays successfully.
    const final = await replayPendingActions(supabase)
    expect(final.dropped).toBe(1)
    expect(final.processed).toBe(1)
    expect(final.stalled).toBe(false)
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(1) // poison discarded
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(2) // unblocked + synced
    expect(state.queue).toHaveLength(0)

    // The user-facing notice was persisted so the discarded change isn't silent.
    const notices = getDiscardedChanges()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ id: 1, type: 'archive-highlight', label: 'Archiving a highlight' })
  })

  it('never drops a transient (codeless/network) failure — retries forever', async () => {
    state.queue = [{ id: 1, type: 'archive-highlight', params: { highlightId: 'h1' }, createdAt: 1 }]
    // A network failure: no `code`. Must be treated as transient.
    const supabase = makeSupabase({ error: { message: 'TypeError: Failed to fetch' } })

    for (let i = 0; i < 10; i++) {
      const r = await replayPendingActions(supabase)
      expect(r.stalled).toBe(true)
      expect(r.dropped).toBe(0)
    }

    // The attempt budget was never touched and the action is still queued.
    expect(offlineMocks.incrementActionAttempts).not.toHaveBeenCalled()
    expect(offlineMocks.removeAction).not.toHaveBeenCalled()
    expect(state.queue).toHaveLength(1)
    // Nothing was discarded, so no user-facing notice.
    expect(getDiscardedChanges()).toHaveLength(0)
  })
})
