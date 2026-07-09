/**
 * Regression test for "an edit made mid-sync never syncs".
 *
 * Root cause: components/OfflineSync.tsx is single-flight (one drain at a time)
 * and lib/offlineReplay.ts snapshots the queue ONCE at the start of a drain. So
 * an action enqueued WHILE a drain is running isn't in that snapshot, and its
 * `offline-action-enqueued` trigger was swallowed by the single-flight guard
 * (early return, no re-run). The action then sat unsynced until the next
 * independent trigger (a real reconnect), while the just-finished drain's
 * `offline-sync-complete` reloaded server truth that lacked it — surfacing as
 * "I edited a highlight but it didn't sync / I still see the original".
 *
 * Fix: a `dirty` ref. A trigger arriving during a drain sets it, and the drain
 * loops once more to pick up the freshly-queued action in the SAME cycle.
 *
 * This test enqueues a second action mid-drain and asserts BOTH are removed
 * (i.e. both were replayed), not just the one in the original snapshot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const online = vi.hoisted(() => ({ value: true }))

// Mutable queue: starts with one action; the test pushes a second mid-drain.
// removeAction mutates it (so each drain's snapshot reflects prior removals) and
// countReplayable/getPendingActions read the live state.
const state = vi.hoisted(() => ({
  queue: [{ id: 1, type: 'unpin-highlight', params: { highlightId: 'h1' }, createdAt: 1 }] as any[],
}))

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => state.queue.slice()),
  removeAction: vi.fn(async (id: number) => {
    state.queue = state.queue.filter((a) => a.id !== id)
  }),
  enqueueOfflineAction: vi.fn(async () => 0),
}))

vi.mock('@/hooks/useOfflineStatus', () => ({
  useOfflineStatus: () => ({ isOnline: online.value }),
}))

vi.mock('@/lib/offlineStore', () => offlineMocks)
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))
vi.mock('@/lib/removeFromFutureMonths', () => ({ removeFromFutureMonths: vi.fn(async () => {}) }))

const supabaseSingleton = {
  auth: {
    getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'u1' } } })),
  },
  // Serve the replay's review-settings read (no row -> monthly defaults); a
  // missing implementation reads as a failed settings fetch, which now stalls
  // the drain instead of guessing a cadence.
  from: vi.fn((table: string) =>
    table === 'user_review_settings'
      ? ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        } as any)
      : ({} as any)
  ),
}
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => supabaseSingleton,
}))

beforeEach(() => {
  online.value = true
  state.queue = [{ id: 1, type: 'unpin-highlight', params: { highlightId: 'h1' }, createdAt: 1 }]
  offlineMocks.getPendingActions.mockClear()
  offlineMocks.removeAction.mockClear()
  // Slow the per-action unpin (fetch) so the first drain is still in flight when
  // we enqueue the second action.
  global.fetch = vi.fn(
    () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({}) } as any), 50))
  ) as any
})

import OfflineSync from '@/components/OfflineSync'

describe('offline replay — enqueue during an in-flight drain', () => {
  it('drains an action queued mid-sync in the same cycle (does not swallow it)', async () => {
    render(<OfflineSync />)

    // First drain has started (action 1's slow unpin is in flight). Simulate an
    // edit being made now: push a second action and fire the enqueue event the
    // way enqueueOfflineAction does. The single-flight guard returns early but
    // marks the run dirty.
    await act(async () => {
      await sleep(10)
      state.queue = [
        ...state.queue,
        { id: 2, type: 'unpin-highlight', params: { highlightId: 'h2' }, createdAt: 2 },
      ]
      window.dispatchEvent(new Event('offline-action-enqueued'))
    })

    // Let the drain finish action 1, loop on `dirty`, and pick up action 2.
    await act(async () => {
      await sleep(400)
    })

    // Both actions replayed → both removed. Before the fix only action 1 (the
    // original snapshot) was removed; action 2 lingered unsynced.
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(1)
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(2)
    expect(offlineMocks.removeAction).toHaveBeenCalledTimes(2)
  })
})
