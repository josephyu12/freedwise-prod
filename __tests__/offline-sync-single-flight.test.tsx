/**
 * Regression test for the negative "changes to sync" counter.
 *
 * Root cause: the offline-replay effect in app/review/page.tsx (and the twin in
 * app/daily/page.tsx) ran on [isOnline] with no concurrency guard. A flapping
 * connection — the heartbeat in useOfflineStatus toggling isOnline
 * false→true→false→true on a weak signal — re-fired the effect while a prior
 * replay was still awaiting Supabase. The two concurrent runs each read an
 * overlapping snapshot of the IndexedDB queue and each ran the
 * `removeAction(id)` + `setPendingSyncCount(prev => prev - 1)` pair for the SAME
 * actions (removeAction is idempotent against IndexedDB, so the duplicate
 * removal resolved cleanly). The decrements stacked past the initial
 * setPendingSyncCount(actions.length), driving the visible counter negative
 * (the reported -15).
 *
 * The fix is a synchronous `useRef` single-flight lock, checked-and-set with no
 * await in between, so the second concurrent run bails before it touches the
 * queue or the counter.
 *
 * removeAction is called exactly once per queued action it actually processes,
 * immediately before each decrement — so "removeAction called N times" is a
 * faithful proxy for "the counter was decremented N times". A guarded replay
 * processes each of the 3 queued actions once (3 calls); the unguarded race
 * processed them twice (6 calls) and is what drove the counter below zero.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Mutable online-state holder the mocked useOfflineStatus reads each render, so
// the test can flap the connection by mutating it and re-rendering.
const online = vi.hoisted(() => ({ value: true }))

// Three queued offline actions. getPendingActions returns the SAME array on
// every call (removeAction is mocked and does not mutate it), which models the
// worst case: a second concurrent run sees every action again before the first
// run's removals have landed.
const QUEUE = vi.hoisted(() => [
  { id: 1, type: 'unpin-highlight', params: { highlightId: 'h1' }, createdAt: 1 },
  { id: 2, type: 'unpin-highlight', params: { highlightId: 'h2' }, createdAt: 2 },
  { id: 3, type: 'unpin-highlight', params: { highlightId: 'h3' }, createdAt: 3 },
])

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => QUEUE),
  removeAction: vi.fn(async () => {}),
  enqueueOfflineAction: vi.fn(async () => 0),
  cacheReviewData: vi.fn(async () => {}),
  getCachedReviewData: vi.fn(async () => undefined),
}))

vi.mock('@/hooks/useOfflineStatus', () => ({
  useOfflineStatus: () => ({ isOnline: online.value }),
}))

vi.mock('@/lib/offlineStore', () => offlineMocks)

// Permissive Supabase stand-in. getSession returns no user so loadHighlights()
// short-circuits — the page renders its empty state, but the replay effect
// (which is what we're testing) still runs on its own [isOnline] schedule.
const makeBuilder = () => {
  const b: any = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    neq: vi.fn(() => b),
    not: vi.fn(() => b),
    order: vi.fn(() => b),
    range: vi.fn(() => b),
    insert: vi.fn(() => b),
    update: vi.fn(() => b),
    delete: vi.fn(() => b),
    upsert: vi.fn(() => b),
    single: vi.fn(() => Promise.resolve({ data: null, error: null })),
    then: (resolve: any, reject: any) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject),
  }
  return b
}
// Stable singleton — the real createClient returns a memoized browser client,
// and loadHighlights's useCallback deps include it. A fresh object per render
// would recreate the callback every render and spin the load effect forever.
const supabaseSingleton = {
  auth: {
    getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
    getUser: vi.fn(() => Promise.resolve({ data: { user: null } })),
  },
  from: vi.fn(() => makeBuilder()),
}
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => supabaseSingleton,
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock('next/link', () => ({ default: (props: any) => props.children }))
vi.mock('@/components/RichTextEditor', () => ({ default: () => null }))
vi.mock('@/components/PinDialog', () => ({ default: () => null }))
vi.mock('@/lib/notionSyncQueue', () => ({ addToNotionSyncQueue: vi.fn(async () => {}) }))
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))

// Slow the per-action replay write so the first run is still in flight when we
// flap the connection. Each unpin action awaits this DELETE before its
// removeAction/decrement; 3 actions ≈ 150ms of flight, plenty of overlap.
beforeEach(() => {
  online.value = true
  offlineMocks.getPendingActions.mockClear()
  offlineMocks.removeAction.mockClear()
  global.fetch = vi.fn(
    () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({}) } as any), 50))
  ) as any
})

import ReviewPage from '@/app/review/page'

describe('offline replay — single-flight guard', () => {
  it('processes each queued action exactly once when the connection flaps mid-sync', async () => {
    const { rerender } = render(<ReviewPage />)

    // Flap the connection while the first replay is still awaiting its first
    // DELETE: online → offline → online. Each transition is its own act() so
    // React commits the intermediate isOnline=false — otherwise the two
    // rerenders batch into a single commit, isOnline never changes value, and
    // the replay effect (deps: [isOnline]) never re-fires. Without the guard
    // the online→true transition fires a second, overlapping replay over the
    // same queue snapshot.
    await act(async () => {
      online.value = false
      rerender(<ReviewPage />)
    })
    await act(async () => {
      online.value = true
      rerender(<ReviewPage />)
    })

    // Let both potential runs (and the slow DELETEs) fully settle.
    await act(async () => {
      await sleep(400)
    })

    // The guard lets only one replay through: 3 actions → 3 removals → 3
    // decrements, never the 6 that pushed the counter to a negative number.
    expect(offlineMocks.removeAction).toHaveBeenCalledTimes(3)
  })
})
