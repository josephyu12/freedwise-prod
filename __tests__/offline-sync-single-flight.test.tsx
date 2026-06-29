/**
 * Regression test for the negative "changes to sync" counter.
 *
 * Root cause: the offline-replay effect ran on [isOnline] with no concurrency
 * guard. A flapping connection — the heartbeat in useOfflineStatus toggling
 * isOnline false→true→false→true on a weak signal — re-fired the effect while a
 * prior replay was still awaiting Supabase. The two concurrent runs each read an
 * overlapping snapshot of the IndexedDB queue and each ran removeAction(id) for
 * the SAME actions (removeAction is idempotent, so the duplicate removal
 * resolved cleanly), stacking the decrements past the initial count and driving
 * the visible counter negative (the reported -15).
 *
 * The replay was since consolidated into one global drainer — components/
 * OfflineSync.tsx (single-flight useRef) + lib/offlineReplay.ts — so it now runs
 * once app-wide instead of a copy per page. This test exercises that drainer:
 * removeAction must be called exactly once per queued action even when the
 * connection flaps mid-sync (3 actions → 3 removals, never 6).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Mutable online-state holder the mocked useOfflineStatus reads each render, so
// the test can flap the connection by mutating it and re-rendering.
const online = vi.hoisted(() => ({ value: true }))

// Three queued offline actions. removeAction mutates the backing queue (as real
// IndexedDB does) and getPendingActions returns a fresh snapshot of the live
// state — so once the single-flight drain removes an action, no later read (or
// re-drain loop) sees it again. The guard's job is to prevent two OVERLAPPING
// drains: if it ever let a second run start before the first's removals landed,
// that run would re-read and re-remove the same ids, doubling the count.
const state = vi.hoisted(() => ({ queue: [] as any[] }))
const initialQueue = () => [
  { id: 1, type: 'unpin-highlight', params: { highlightId: 'h1' }, createdAt: 1 },
  { id: 2, type: 'unpin-highlight', params: { highlightId: 'h2' }, createdAt: 2 },
  { id: 3, type: 'unpin-highlight', params: { highlightId: 'h3' }, createdAt: 3 },
]

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

// Supabase stand-in. getUser returns a user so replayPendingActions proceeds
// (it no-ops when signed out). The queued actions are unpins, which only hit
// fetch() — no table writes — so a permissive builder is enough.
const supabaseSingleton = {
  auth: {
    getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'u1' } } })),
  },
  from: vi.fn(() => ({})),
}
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => supabaseSingleton,
}))

// Slow the per-action replay write so the first run is still in flight when we
// flap the connection. Each unpin awaits this DELETE before its removeAction;
// 3 actions ≈ 150ms of flight, plenty of overlap.
beforeEach(() => {
  online.value = true
  state.queue = initialQueue()
  offlineMocks.getPendingActions.mockClear()
  offlineMocks.removeAction.mockClear()
  global.fetch = vi.fn(
    () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({}) } as any), 50))
  ) as any
})

import OfflineSync from '@/components/OfflineSync'

describe('offline replay — single-flight guard', () => {
  it('processes each queued action exactly once when the connection flaps mid-sync', async () => {
    const { rerender } = render(<OfflineSync />)

    // Flap the connection while the first replay is still awaiting its first
    // DELETE: online → offline → online. Each transition is its own act() so
    // React commits the intermediate isOnline=false — otherwise the two
    // rerenders batch into a single commit, isOnline never changes value, and
    // the effect (deps: [isOnline]) never re-fires. Without the guard the
    // online→true transition fires a second, overlapping replay over the same
    // queue snapshot.
    await act(async () => {
      online.value = false
      rerender(<OfflineSync />)
    })
    await act(async () => {
      online.value = true
      rerender(<OfflineSync />)
    })

    // Let both potential runs (and the slow DELETEs) fully settle.
    await act(async () => {
      await sleep(400)
    })

    // The guard lets only one replay through: 3 actions → 3 removals, never the
    // 6 that pushed the counter to a negative number.
    expect(offlineMocks.removeAction).toHaveBeenCalledTimes(3)
  })
})
