/**
 * Regression tests for two ways the offline drain could wedge or misbehave:
 *
 * 1. An unexpected throw inside a drain pass (an IndexedDB read blowing up
 *    between passes) used to reject the shared drain promise WITHOUT firing
 *    onComplete — the "Syncing…" banner (useOfflineSyncState) had seen onStart
 *    and now spun forever, and every joined caller got an unhandled rejection.
 *    The drain must settle as a normal stalled result instead.
 *
 * 2. Flipping manual offline mode ON mid-drain only aborted Supabase writes
 *    (via the shared abort signal in lib/supabase/client). The raw-fetch
 *    replays (pin/unpin) and the loop itself marched on through the rest of
 *    the queue over a connection the user had explicitly opted out of. The
 *    loop must re-check between actions and stall immediately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({ queue: [] as any[] }))

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => state.queue.slice()),
  removeAction: vi.fn(async (id: number) => {
    state.queue = state.queue.filter((a) => a.id !== id)
  }),
  incrementActionAttempts: vi.fn(async () => 1),
}))

vi.mock('@/lib/offlineStore', () => offlineMocks)
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))
vi.mock('@/lib/removeFromFutureMonths', () => ({ removeFromFutureMonths: vi.fn(async () => {}) }))
// freq is irrelevant for the unpin actions used here; keep cycle helpers cheap.
vi.mock('@/lib/cycle', () => ({
  getUserFrequency: vi.fn(async () => 1),
  getCycleForDate: vi.fn(),
  prevCycle: vi.fn(),
  cycleKeyForDate: vi.fn(),
}))

import { drainOfflineQueue, replayPendingActions } from '@/lib/offlineReplay'

const makeSupabase = () =>
  ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => ({})),
  }) as any

beforeEach(() => {
  window.localStorage.clear()
  state.queue = []
  offlineMocks.getPendingActions.mockClear()
  offlineMocks.removeAction.mockClear()
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) } as any)) as any
})

describe('drainOfflineQueue — crash safety', () => {
  it('settles with onComplete (stalled) when a pass throws, instead of rejecting', async () => {
    state.queue = [
      { id: 1, type: 'unpin-highlight', params: { highlightId: 'h1' }, createdAt: 1 },
    ]
    // First read (countReplayable) sees the queue; the read inside the replay
    // pass blows up (simulated IndexedDB failure); the final best-effort count
    // returns empty.
    offlineMocks.getPendingActions
      .mockImplementationOnce(async () => state.queue.slice())
      .mockRejectedValueOnce(new Error('idb blew up'))

    const onStart = vi.fn()
    const onComplete = vi.fn()

    const result = await drainOfflineQueue(makeSupabase(), { onStart, onComplete })

    expect(onStart).toHaveBeenCalledWith(1)
    // The whole point: onComplete fired despite the crash, so the banner's
    // isSyncing flips back off — and the promise resolved rather than rejected.
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0]).toMatchObject({ stalled: true, processed: 0 })
    expect(result).toMatchObject({ stalled: true, processed: 0 })
  })
})

describe('replayPendingActions — manual offline mid-drain', () => {
  it('stops before the next action when the switch flips on during the drain', async () => {
    state.queue = [
      { id: 1, type: 'unpin-highlight', params: { highlightId: 'h1' }, createdAt: 1 },
      { id: 2, type: 'unpin-highlight', params: { highlightId: 'h2' }, createdAt: 2 },
    ]
    // The first action's network call is the moment the user flips the switch.
    global.fetch = vi.fn(async () => {
      window.localStorage.setItem('freedwise:manual-offline', '1')
      return { ok: true, json: async () => ({}) } as any
    }) as any

    const result = await replayPendingActions(makeSupabase())

    // Action 1 completed and was removed; action 2 was NOT attempted — the loop
    // stalled the drain the moment it saw the switch.
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(offlineMocks.removeAction).toHaveBeenCalledTimes(1)
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(1)
    expect(state.queue.map((a) => a.id)).toEqual([2])
    expect(result).toMatchObject({ processed: 1, stalled: true })
  })
})
