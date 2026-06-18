/**
 * Regression test for the widget progress denominator (reported as "45/46").
 *
 * Root cause: the widget computed `total`/`reviewed` from a raw count of every
 * daily_summary_highlights row for the day, with NO archived filter — while the
 * "next highlight" query filters `highlights!inner` + archived=false. An
 * archived (or deleted/orphaned) unrated highlight therefore inflated `total`
 * to 46 but could never be presented for review or cleared, stranding the widget
 * at 45/46 even after the user reviewed all 45 visible highlights.
 *
 * The fix makes the count query use the same `highlights!inner` +
 * `.eq('highlight.archived', false)` filter as the review flow.
 *
 * This test models a day with 46 daily_summary_highlights rows: 45 non-archived
 * (all rated) + 1 archived (unrated). The fake Supabase builder returns the
 * archived row ONLY when the count query omits the archived filter — i.e. the
 * pre-fix behavior. So:
 *   - without the fix → total=46, reviewed=45 (test FAILS)
 *   - with the fix    → total=45, reviewed=45 (test PASSES)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'crypto'

const SECRET = 'test-service-role-key'

// 45 reviewable rows, all rated; plus 1 archived, unrated row that should be
// excluded from the counts once the fix applies.
const REVIEWABLE = Array.from({ length: 45 }, (_, i) => ({
  id: `dsh-${i}`,
  rating: 3,
  highlight: { id: `h-${i}`, archived: false },
}))
const ARCHIVED_UNRATED = {
  id: 'dsh-archived',
  rating: null,
  highlight: { id: 'h-archived', archived: true },
}

// Chainable Supabase query stub. Records the filters applied so the terminal
// resolution can mimic how Postgres would answer each distinct query.
function makeClient() {
  function builder(table: string) {
    const state: any = { table, eqs: {} as Record<string, any>, isNull: false }
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => {
        state.eqs[col] = val
        return b
      },
      gte: () => b,
      lt: () => b,
      order: () => b,
      is: () => {
        state.isNull = true
        return b
      },
      maybeSingle: () => {
        if (state.table === 'daily_summaries') {
          return Promise.resolve({ data: { id: 'summary-1' }, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      // Thenable so `await builder` resolves like a real query.
      then: (onF: any, onR: any) => Promise.resolve(resolve(state)).then(onF, onR),
    }
    return b
  }

  function resolve(state: any) {
    if (state.table !== 'daily_summary_highlights') {
      return { data: [], error: null }
    }
    // Queries with `.is('rating', null)` are the next-highlight / catch-up
    // lookups. Everything is reviewed, so they return nothing.
    if (state.isNull) return { data: [], error: null }
    // Otherwise this is the count query. Postgres applies the archived filter
    // only when the code asked for it (the fix). Pre-fix, the archived row leaks
    // into the count.
    const rows =
      state.eqs['highlight.archived'] === false
        ? REVIEWABLE
        : [...REVIEWABLE, ARCHIVED_UNRATED]
    return { data: rows, error: null }
  }

  return { from: (table: string) => builder(table) }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeClient(),
}))

function makeToken(userId: string) {
  const expiry = String(Date.now() + 60_000)
  const sig = crypto.createHmac('sha256', SECRET).update(`${userId}.${expiry}`).digest('hex')
  return `${userId}.${expiry}.${sig}`
}

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
})

describe('widget progress count excludes archived highlights', () => {
  it('reports 45/45 (not 45/46) when all 45 reviewable highlights are rated', async () => {
    const { GET } = await import('@/app/api/review/widget/route')
    const token = makeToken('user-1')
    const req: any = {
      nextUrl: new URL(`http://localhost/api/review/widget?token=${token}&date=2026-06-17`),
    }

    const res = await GET(req)
    const body = await res.json()

    expect(body.total).toBe(45)
    expect(body.reviewed).toBe(45)
    expect(body.allDone).toBe(true)
  })
})
