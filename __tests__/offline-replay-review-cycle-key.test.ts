/**
 * Regression test: the offline `rate-review` replay must key the reviewed ledger
 * (highlight_months_reviewed) by the cycle of the RATED highlight's own day, not
 * the day the action was queued.
 *
 * The bug: keying by `today` meant rating a catch-up/ahead highlight that belongs
 * to a different cycle than today wrote the wrong cycle key — a phantom ledger
 * row in today's cycle that under-weighted that day in redistribute and skewed
 * "reviewed this cycle" stats. Actions queued before the fix lack `summaryDate`,
 * so replay must fall back to the queued `today` for backward compatibility.
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
// Use the REAL cycle math (so key derivation is actually verified); only the
// per-user frequency lookup is stubbed to freq=2 (Jul–Aug is one cycle: 2026-07).
vi.mock('@/lib/cycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cycle')>()
  return { ...actual, getUserFrequency: vi.fn(async () => 2) }
})

import { replayPendingActions } from '@/lib/offlineReplay'

// Captures every highlight_months_reviewed upsert's month_year.
const ledgerKeys: string[] = []

function makeSupabase() {
  const chain = (result: any): any => ({
    select: () => chain(result),
    update: () => chain(result),
    upsert: (rows: any) => {
      const arr = Array.isArray(rows) ? rows : [rows]
      for (const r of arr) if (r && r.month_year) ledgerKeys.push(r.month_year)
      return chain(result)
    },
    eq: () => chain(result),
    not: () => chain(result),
    single: () => Promise.resolve(result),
    then: (resolve: any) => resolve(result),
  })
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (table: string) =>
      chain(table === 'highlights' ? { data: { unarchived_at: null }, error: null } : { data: [], error: null }),
  } as any
}

beforeEach(() => {
  ledgerKeys.length = 0
  state.queue = []
  offlineMocks.removeAction.mockClear()
})

describe('offline rate-review — ledger keyed by the rated day, not queue day', () => {
  it('keys by summaryDate cycle when the rating is for a different cycle than today', async () => {
    // Rated a June 15 highlight (cycle 2026-05) while today is July 2 (cycle 2026-07).
    state.queue = [
      {
        id: 1,
        type: 'rate-review',
        params: {
          summaryHighlightId: 'sh1',
          highlightId: 'h1',
          rating: 'high',
          today: '2026-07-02',
          summaryDate: '2026-06-15',
        },
        createdAt: 1,
      },
    ]
    await replayPendingActions(makeSupabase())
    expect(ledgerKeys).toEqual(['2026-05']) // June 15 → May–Jun cycle, NOT 2026-07
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(1)
  })

  it('falls back to queued `today` when summaryDate is absent (pre-fix actions)', async () => {
    state.queue = [
      {
        id: 2,
        type: 'rate-review',
        params: {
          summaryHighlightId: 'sh2',
          highlightId: 'h2',
          rating: 'med',
          today: '2026-07-02',
          // no summaryDate — queued before the fix
        },
        createdAt: 2,
      },
    ]
    await replayPendingActions(makeSupabase())
    expect(ledgerKeys).toEqual(['2026-07'])
    expect(offlineMocks.removeAction).toHaveBeenCalledWith(2)
  })
})
