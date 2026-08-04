/**
 * Regression test: the "Syncing…" banner was invisible during page loading.
 *
 * The banner used to be rendered per-page and fed ONLY by the fire-and-forget
 * `offline-sync-start` window event. On a cold load the global <OfflineSync>
 * drainer starts syncing while the page is still showing its "Loading..."
 * screen — so by the time the page mounted and subscribed, the start event was
 * long gone and the banner stayed blank. The user saw a bare "Loading..." with
 * no indication anything was happening: the app looked frozen.
 *
 * Fix: the drain keeps a module-level snapshot, and useOfflineSyncState seeds
 * from it on mount. Anything that mounts mid-drain knows a sync is in flight.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const state = vi.hoisted(() => ({ queue: [] as any[] }))

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => state.queue.slice()),
  removeAction: vi.fn(async (id: number) => {
    state.queue = state.queue.filter((a) => a.id !== id)
  }),
  incrementActionAttempts: vi.fn(async () => 1),
  // <OfflineSync> keeps the queue's owner stamp primed through this.
  rememberUserId: vi.fn(),
}))

vi.mock('@/lib/offlineStore', () => offlineMocks)
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))
vi.mock('@/lib/removeFromFutureMonths', () => ({ removeFromFutureMonths: vi.fn(async () => {}) }))
vi.mock('@/lib/cycle', () => ({
  getUserFrequency: vi.fn(async () => 1),
  getCycleForDate: vi.fn(),
  prevCycle: vi.fn(),
  cycleKeyForDate: vi.fn(),
}))

import { drainOfflineQueue } from '@/lib/offlineReplay'
import { useOfflineSyncState } from '@/hooks/useOfflineSyncState'
import OfflineBanner from '@/components/OfflineBanner'

// Stand-in for the layout's <SyncBanner>, mounted late (mid-drain) the way a
// page does when it finally comes out of its loading state.
function LateMountingBanner() {
  const { isSyncing, pendingCount } = useOfflineSyncState()
  return <OfflineBanner isOnline={true} isSyncing={isSyncing} pendingCount={pendingCount} />
}

const makeSupabase = () =>
  ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })),
      // <OfflineSync> subscribes here to keep the offline queue's owner stamp
      // primed without any auth call on the rating path.
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(() => ({})),
  }) as any

beforeEach(() => {
  window.localStorage.clear()
  state.queue = []
  offlineMocks.getPendingActions.mockClear()
  offlineMocks.removeAction.mockClear()
})

describe('sync banner during a drain that started before it mounted', () => {
  it('shows "Syncing…" when mounted mid-drain, and clears when the drain finishes', async () => {
    state.queue = [
      { id: 1, type: 'unpin-highlight', params: { highlightId: 'h1' }, createdAt: 1 },
    ]

    // Hold the replay open so the drain is still in flight while we mount.
    let releaseFetch: () => void = () => {}
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    global.fetch = vi.fn(async () => {
      await fetchGate
      return { ok: true, json: async () => ({}) } as any
    }) as any

    const drain = drainOfflineQueue(makeSupabase())
    // Let the drain get as far as counting the queue and starting the replay.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The banner mounts now — long after any `offline-sync-start` event.
    render(<LateMountingBanner />)
    expect(screen.getByText(/Syncing/)).toBeTruthy()

    releaseFetch()
    await act(async () => {
      await drain
    })

    expect(screen.queryByText(/Syncing/)).toBeNull()
  })

  it('renders nothing when online with no drain in flight', () => {
    render(<LateMountingBanner />)
    expect(screen.queryByText(/Syncing/)).toBeNull()
  })
})
