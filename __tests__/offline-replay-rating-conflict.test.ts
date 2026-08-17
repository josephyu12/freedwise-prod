/**
 * Offline replay: two queued ratings of the same appearance from "two devices"
 * (simulated as two drains) keep the earlier tap, not whichever drain ran last.
 *
 * Same-device rate-then-change in one queue: only the last queued rating is
 * written (this device's latest intent).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { toRatedAtIso } from '@/lib/applyRating'

const state = vi.hoisted(() => ({ queue: [] as any[] }))

const offlineMocks = vi.hoisted(() => ({
  getPendingActions: vi.fn(async () => state.queue.slice()),
  removeAction: vi.fn(async (id: number) => {
    state.queue = state.queue.filter((a) => a.id !== id)
  }),
  incrementActionAttempts: vi.fn(async () => 1),
  rememberUserId: vi.fn(),
}))

vi.mock('@/lib/offlineStore', () => offlineMocks)
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))
vi.mock('@/lib/removeFromFutureMonths', () => ({ removeFromFutureMonths: vi.fn(async () => {}) }))
vi.mock('@/lib/cycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cycle')>()
  return { ...actual, getUserFrequency: vi.fn(async () => 1) }
})

import { replayPendingActions } from '@/lib/offlineReplay'

function makeSupabase(
  row: { rating: string | null; rated_at: string | null },
  opts: { statsError?: any } = {}
) {
  const chainFor = (table: string): any => {
    let patch: any = null
    let filter: string | undefined
    const chain: any = {
      select: (cols?: string) => {
        if (patch && table === 'daily_summary_highlights') {
          return Promise.resolve(applyPatch())
        }
        if (table === 'highlights' && cols?.includes('unarchived_at')) {
          return chain
        }
        return chain
      },
      update: (vals: any) => {
        patch = vals
        return chain
      },
      upsert: () => chain,
      eq: () => chain,
      or: (f: string) => {
        filter = f
        return chain
      },
      not: () => chain,
      maybeSingle: async () => ({ data: { rating: row.rating }, error: null }),
      single: async () =>
        opts.statsError
          ? { data: null, error: opts.statsError }
          : { data: { unarchived_at: null, archived: false }, error: null },
      then: (resolve: any) => {
        if (patch && table === 'daily_summary_highlights') return resolve(applyPatch())
        return resolve({ data: [], error: null })
      },
    }
    function applyPatch() {
      const incomingIso = patch.rated_at as string
      const overwrite = !filter
      const wins =
        overwrite ||
        row.rating == null ||
        (row.rated_at != null && row.rated_at > incomingIso)
      if (!wins) return { data: [], error: null }
      row.rating = patch.rating
      row.rated_at = patch.rated_at
      return { data: [{ id: 'sh1', rating: row.rating }], error: null }
    }
    return chain
  }

  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (table: string) => chainFor(table),
  } as any
}

beforeEach(() => {
  state.queue = []
  offlineMocks.removeAction.mockClear()
})

function rateAction(id: number, rating: string, createdAt: number, overwrite?: boolean) {
  return {
    id,
    type: 'rate-review',
    params: {
      summaryHighlightId: 'sh1',
      highlightId: 'h1',
      rating,
      today: '2026-08-13',
      summaryDate: '2026-08-13',
      ratedAt: createdAt,
      ...(overwrite ? { overwrite } : {}),
    },
    createdAt,
  }
}

describe('offline rating conflict — earlier tap wins', () => {
  it('keeps the earlier device when the later device drains last', async () => {
    const row = { rating: null as string | null, rated_at: null as string | null }
    const supabase = makeSupabase(row)

    state.queue = [rateAction(1, 'high', 1_000)]
    await replayPendingActions(supabase)
    expect(row.rating).toBe('high')
    expect(row.rated_at).toBe(toRatedAtIso(1_000))

    state.queue = [rateAction(2, 'low', 2_000)]
    await replayPendingActions(supabase)
    expect(row.rating).toBe('high')
    expect(row.rated_at).toBe(toRatedAtIso(1_000))
  })

  it('lets the earlier device overwrite if it drains second', async () => {
    const row = { rating: null as string | null, rated_at: null as string | null }
    const supabase = makeSupabase(row)

    state.queue = [rateAction(2, 'low', 2_000)]
    await replayPendingActions(supabase)
    expect(row.rating).toBe('low')

    state.queue = [rateAction(1, 'high', 1_000)]
    await replayPendingActions(supabase)
    expect(row.rating).toBe('high')
    expect(row.rated_at).toBe(toRatedAtIso(1_000))
  })

  it('writes only the last queued rating for the same row on this device', async () => {
    const row = { rating: null as string | null, rated_at: null as string | null }
    const supabase = makeSupabase(row)

    state.queue = [rateAction(1, 'low', 1_000), rateAction(2, 'med', 1_500)]
    await replayPendingActions(supabase)
    expect(row.rating).toBe('med')
    expect(row.rated_at).toBe(toRatedAtIso(1_500))
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(1)
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(2)
  })

  it('honors the overwrite flag: a queued re-rate lands over its own earlier tap', async () => {
    const row = { rating: null as string | null, rated_at: null as string | null }
    const supabase = makeSupabase(row)

    // First tap synced yesterday.
    state.queue = [rateAction(1, 'low', 1_000)]
    await replayPendingActions(supabase)
    expect(row.rating).toBe('low')

    // The user CHANGES that visible rating while offline. Without the flag,
    // earlier-tap-wins would silently keep 'low'.
    state.queue = [rateAction(2, 'high', 2_000, true)]
    await replayPendingActions(supabase)
    expect(row.rating).toBe('high')
    expect(row.rated_at).toBe(toRatedAtIso(2_000))
  })

  it('keeps the rating queued when stats bookkeeping errors, so the average retries with it', async () => {
    const row = { rating: null as string | null, rated_at: null as string | null }
    // A coded error from the stats read (e.g. the highlight row vanished).
    // Average update is part of the same rating action — do not skip it or
    // enqueue a second change. The rating write itself already landed and is
    // idempotent on the next drain.
    const supabase = makeSupabase(row, {
      statsError: { code: 'PGRST116', message: 'JSON object requested, no rows returned' },
    })

    state.queue = [rateAction(1, 'high', 1_000)]
    const result = await replayPendingActions(supabase)

    expect(row.rating).toBe('high')
    expect(result.processed).toBe(0)
    expect(result.stalled).toBe(true)
    expect(offlineMocks.removeAction).not.toHaveBeenCalled()
    expect(offlineMocks.incrementActionAttempts).toHaveBeenCalledWith(1)
  })
})
