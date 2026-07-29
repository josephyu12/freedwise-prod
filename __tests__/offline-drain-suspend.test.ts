/**
 * Tests for suspending the offline drain (lib/offlineReplay.ts).
 *
 * The behavior being guarded: a drain kicked off by reconnect is a long serial
 * run of writes, and the moment the user wants to open something — "Review
 * ahead" especially — is exactly when it shouldn't be hogging the connection.
 * A page load parks it for the length of its reads.
 *
 * Parking, not bailing out: the drain stays in flight so the banner keeps
 * reporting it honestly and no premature `offline-sync-complete` fires a reload
 * underneath the load being yielded to. And it can never wedge — the last
 * release resumes it, and a caller that leaks a suspension is force-resumed by
 * the watchdog.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
vi.mock('@/lib/cycle', () => ({
  getUserFrequency: vi.fn(async () => 1),
  getCycleForDate: vi.fn(),
  prevCycle: vi.fn(),
  cycleKeyForDate: vi.fn(),
}))

import {
  drainOfflineQueue,
  replayPendingActions,
  suspendDrain,
  resumeDrain,
  isDrainSuspended,
} from '@/lib/offlineReplay'

const makeSupabase = () =>
  ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => ({})),
  }) as any

// unpin replays over raw fetch, so `global.fetch` is a clean per-action hook.
const unpins = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    type: 'unpin-highlight',
    params: { highlightId: `h${i + 1}` },
    createdAt: i + 1,
  }))

/** Let queued microtasks/timers settle so a parked drain can make progress. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  window.localStorage.clear()
  state.queue = []
  offlineMocks.getPendingActions.mockClear()
  offlineMocks.removeAction.mockClear()
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any) as any
})

afterEach(() => {
  // Never leak a suspension into the next test.
  while (isDrainSuspended()) resumeDrain()
  vi.useRealTimers()
})

describe('suspendDrain / resumeDrain', () => {
  it('parks the drain at the next action boundary and finishes it on resume', async () => {
    state.queue = unpins(3)
    // The first action's network call is the moment a page load starts reading.
    global.fetch = vi.fn(async () => {
      suspendDrain()
      return { ok: true, json: async () => ({}) } as any
    }) as any

    const drain = replayPendingActions(makeSupabase())
    await settle()

    // Action 1 finished (a write in flight is never abandoned); actions 2 and 3
    // are untouched while the load reads.
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(state.queue.map((a) => a.id)).toEqual([2, 3])

    // Still parked — a suspended drain must not quietly march on.
    await settle()
    expect(global.fetch).toHaveBeenCalledTimes(1)

    // Load done. Let it fetch normally from here so it can drain out.
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any) as any
    resumeDrain()

    const result = await drain
    expect(result).toMatchObject({ processed: 3, stalled: false })
    expect(state.queue).toEqual([])
  })

  it('stays parked until the LAST of two overlapping loads releases', async () => {
    state.queue = unpins(2)
    global.fetch = vi.fn(async () => {
      suspendDrain()
      suspendDrain() // a second page load arrives mid-read
      return { ok: true, json: async () => ({}) } as any
    }) as any

    const drain = replayPendingActions(makeSupabase())
    await settle()
    expect(state.queue.map((a) => a.id)).toEqual([2])

    resumeDrain()
    await settle()
    // One load is still reading — the drain must not restart yet.
    expect(state.queue.map((a) => a.id)).toEqual([2])

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any) as any
    resumeDrain()
    await drain
    expect(state.queue).toEqual([])
  })

  it('does not announce completion while parked (no reload under the load)', async () => {
    state.queue = unpins(2)
    const events: string[] = []
    const record = (e: Event) => events.push(e.type)
    for (const t of ['offline-sync-start', 'offline-sync-complete']) {
      window.addEventListener(t, record)
    }

    global.fetch = vi.fn(async () => {
      suspendDrain()
      return { ok: true, json: async () => ({}) } as any
    }) as any

    const drain = drainOfflineQueue(makeSupabase())
    await settle()

    // The drain started, then parked. Crucially it has NOT reported itself
    // complete — that event is what makes /review reload its highlights.
    expect(events).toEqual(['offline-sync-start'])

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any) as any
    resumeDrain()
    await drain

    expect(events).toEqual(['offline-sync-start', 'offline-sync-complete'])
    for (const t of ['offline-sync-start', 'offline-sync-complete']) {
      window.removeEventListener(t, record)
    }
  })

  it('force-resumes a leaked suspension so the queue can never wedge shut', async () => {
    vi.useFakeTimers()
    state.queue = unpins(2)
    global.fetch = vi.fn(async () => {
      suspendDrain() // a load that dies without ever releasing
      return { ok: true, json: async () => ({}) } as any
    }) as any

    const drain = replayPendingActions(makeSupabase())
    await vi.advanceTimersByTimeAsync(1)
    expect(state.queue.map((a) => a.id)).toEqual([2])

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any) as any
    // The watchdog armed by the first suspendDrain() fires and clears it.
    await vi.advanceTimersByTimeAsync(15_000)

    await drain
    expect(state.queue).toEqual([])
    expect(isDrainSuspended()).toBe(false)
  })

  it('a drain started while suspended waits instead of opening a pass', async () => {
    state.queue = unpins(1)
    suspendDrain()

    const drain = drainOfflineQueue(makeSupabase())
    await settle()
    // No pass opened — the action is untouched.
    expect(global.fetch).not.toHaveBeenCalled()
    expect(state.queue.map((a) => a.id)).toEqual([1])

    resumeDrain()
    await drain
    expect(state.queue).toEqual([])
  })
})
