/**
 * Regression test for the "reload after every rating in offline mode" bug.
 *
 * Manual offline is for a weak/flapping connection the user wants to opt out of —
 * so navigator.onLine is typically still TRUE while it's on. The global
 * <OfflineSync> drainer listens for `offline-action-enqueued` (fired by every
 * queued rating) and ran runSync() guarded only on navigator.onLine. With a live
 * connection that guard passed, so each rating drained immediately, fired
 * `offline-sync-complete`, and the review page reloaded — once per rating.
 *
 * The fix: runSync bails when readManualOffline() is true. This test seeds the
 * manual switch, fires the enqueue event, and asserts the queue is NOT drained
 * (removeAction never called) even though the connection is online.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Connection is online — manual offline must win regardless.
const online = vi.hoisted(() => ({ value: true }))

// An unpin action — its replay only hits fetch() (no table writes), so a
// permissive supabase stub is enough. The drain guard is type-agnostic; this
// test only cares whether runSync drains AT ALL, not how a specific action
// replays.
const QUEUE = vi.hoisted(() => [
  { id: 1, type: 'unpin-highlight', params: { highlightId: 'h1' }, createdAt: 1 },
])

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => QUEUE),
  removeAction: vi.fn(async () => {}),
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
  from: vi.fn(() => ({})),
}
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => supabaseSingleton,
}))

beforeEach(() => {
  online.value = true
  window.localStorage.clear()
  offlineMocks.getPendingActions.mockClear()
  offlineMocks.removeAction.mockClear()
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) } as any)) as any
})

import OfflineSync from '@/components/OfflineSync'

describe('offline replay — manual offline guard', () => {
  it('does NOT drain the queue on enqueue while manually offline (online connection)', async () => {
    window.localStorage.setItem('freedwise:manual-offline', '1')

    render(<OfflineSync />)

    // A queued rating fires this. With the bug, it would drain immediately.
    await act(async () => {
      window.dispatchEvent(new Event('offline-action-enqueued'))
      await sleep(100)
    })

    expect(offlineMocks.removeAction).not.toHaveBeenCalled()
  })

  it('drains normally once the manual switch is off', async () => {
    // Manual offline NOT set — the same enqueue should drain.
    render(<OfflineSync />)

    await act(async () => {
      window.dispatchEvent(new Event('offline-action-enqueued'))
      await sleep(100)
    })

    expect(offlineMocks.removeAction).toHaveBeenCalledTimes(1)
  })
})
