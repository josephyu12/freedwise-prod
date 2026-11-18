import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { format } from 'date-fns'

const state = vi.hoisted(() => ({
  readRows: vi.fn(), rows: [] as any[], cache: undefined as any, offline: false,
  params: new URLSearchParams(), router: { replace: vi.fn() }, client: null as any,
}))
vi.mock('next/navigation', () => ({ useSearchParams: () => state.params, useRouter: () => state.router }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => state.client }))
vi.mock('@/lib/cycle', async (original) => ({ ...(await original<any>()), getUserReviewSettings: async () => ({ freq: 1, enabled: true }) }))
vi.mock('@/hooks/useOfflineStatus', () => ({ useOfflineStatus: () => ({ isOnline: !state.offline }) }))
vi.mock('@/hooks/useManualOffline', () => ({ isEffectivelyOffline: () => state.offline }))
vi.mock('@/lib/preloadAhead', () => ({ preloadAheadHighlights: vi.fn() }))
vi.mock('@/lib/offlineReplay', () => ({ listReplayable: async () => [], drainOfflineQueue: async () => ({}), suspendDrain: vi.fn(), resumeDrain: vi.fn() }))
vi.mock('@/lib/offlineStore', () => ({
  getCachedReviewData: async () => state.cache,
  cacheReviewData: async (data: any) => { state.cache = data },
  getCachedReviewAheadData: async () => undefined,
  cacheReviewAheadData: async () => {}, isReviewAheadCacheFresh: () => false,
  enqueueOfflineAction: async () => 1, readRememberedUserId: () => 'user-1',
}))
vi.mock('@/lib/highlightStats', () => ({ updateHighlightStatsAfterRating: async () => ({ archivedNow: false }) }))
vi.mock('@/lib/applyRating', () => ({ applySummaryHighlightRating: async (_client: any, params: any) => {
  const row = state.rows.find((r) => r.id === params.summaryHighlightId)
  row.rating = params.rating; row.rated_at = new Date(params.ratedAt).toISOString()
  return { applied: true, rating: params.rating }
} }))
vi.mock('@/components/RichTextEditor', () => ({ default: () => null }))
vi.mock('@/components/PinDialog', () => ({ default: () => null }))
import ReviewPage from '@/app/review/page'

beforeEach(() => {
  localStorage.clear()
  state.offline = false; state.cache = undefined; state.params = new URLSearchParams()
  state.router.replace.mockClear()
  const today = format(new Date(), 'yyyy-MM-dd')
  state.rows = ['A', 'BB', 'CCC'].map((text, i) => ({
    id: `r${i}`, highlight_id: `h${i}`, rating: null, rated_at: null,
    daily_summaries: { id: 'day', date: today },
    highlight: { id: `h${i}`, text, archived: false, highlight_categories: [] },
  }))
  state.readRows.mockReset().mockImplementation(() => ({ data: structuredClone(state.rows), error: null }))
  state.client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
    from: (table: string) => {
      const q: any = { then: (resolve: any) => resolve(table === 'daily_summary_highlights' ? state.readRows() : { data: [], error: null }) }
      for (const op of ['select', 'eq', 'gte', 'lte', 'order', 'range', 'upsert']) q[op] = () => q
      return q
    },
  }
})

describe('real review page resume flow', () => {
  function pauseForegroundRead() {
    let finish!: (response: any) => void
    state.readRows.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent(document, new Event('visibilitychange'))
    return async (response: any) => {
      await waitFor(() => expect(finish).toBeDefined())
      await act(async () => finish(response))
    }
  }

  it('keeps the same card mounted on return while fetching newer progress from another device', async () => {
    render(<ReviewPage />)
    const card = await screen.findByText('A')
    const finish = pauseForegroundRead()
    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))
    await waitFor(() => expect(state.readRows).toHaveBeenCalledTimes(2))
    expect(screen.getByText('A')).toBe(card)
    expect(screen.queryByText('Loading...')).toBeNull()

    state.rows[0].rating = 'high'
    state.rows[0].rated_at = new Date().toISOString()
    await finish({ data: state.rows, error: null })
    await screen.findByText('BB')
    expect(screen.getByText('1 / 3 reviewed')).toBeInTheDocument()
  })

  it('stays on an already-rated card the reader went back to when progress is unchanged', async () => {
    state.rows[0].rating = 'high'
    state.rows[0].rated_at = new Date(Date.now() - 60_000).toISOString()
    render(<ReviewPage />)
    await screen.findByText('BB')
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }))
    const card = await screen.findByText('A')
    const finish = pauseForegroundRead()
    await finish({ data: state.rows, error: null })
    expect(screen.getByText('A')).toBe(card)
  })

  it('keeps a rating made while a foreground read is pending, including in the offline cache', async () => {
    render(<ReviewPage />)
    await screen.findByText('A')
    const oldRows = structuredClone(state.rows)
    const finish = pauseForegroundRead()
    await waitFor(() => expect(state.readRows).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'High', exact: true }))
    await screen.findByText('BB')

    await finish({ data: oldRows, error: null })
    expect(screen.getByText('BB')).toBeInTheDocument()
    expect(screen.getByText('1 / 3 reviewed')).toBeInTheDocument()
    expect(state.cache.highlights[0].rating).toBe('high')
  })

  it('keeps the live page when a foreground read fails with a stale offline cache', async () => {
    render(<ReviewPage />)
    const card = await screen.findByText('A')
    state.cache = { highlights: [], categories: [], pinnedHighlightIds: [] }
    const finish = pauseForegroundRead()
    await finish({ data: null, error: new Error('unreachable') })
    expect(screen.getByText('A')).toBe(card)
  })

  it('skip A → rate B → C survives sync reload and reopening on a fresh device', async () => {
    const page = render(<ReviewPage />)
    await screen.findByText('A')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('BB')
    fireEvent.click(screen.getByRole('button', { name: 'High', exact: true }))
    await screen.findByText('CCC')
    await act(async () => { window.dispatchEvent(new CustomEvent('offline-sync-complete', { detail: { processed: 1 } })) })
    await screen.findByText('CCC')
    page.unmount()
    localStorage.clear()
    render(<ReviewPage />)
    await screen.findByText('CCC')
    expect(screen.queryByText('A')).not.toBeInTheDocument()
  })

  it('remembers Next-only navigation across a reload', async () => {
    const page = render(<ReviewPage />)
    await screen.findByText('A')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('BB')
    page.unmount()
    render(<ReviewPage />)
    await screen.findByText('BB')
  })

  it('preserves the forward resume point after an offline rating and reload', async () => {
    const online = render(<ReviewPage />)
    await screen.findByText('A')
    online.unmount()
    state.offline = true
    const offline = render(<ReviewPage />)
    await screen.findByText('A')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'High', exact: true }))
    await screen.findByText('CCC')
    offline.unmount()
    localStorage.clear() // The cache's rated_at is enough, even without a cursor.
    render(<ReviewPage />)
    await screen.findByText('CCC')
  })

  it('ignores a stale widget link to an already-rated highlight', async () => {
    state.rows[1].rating = 'high'; state.rows[1].rated_at = new Date().toISOString()
    state.params = new URLSearchParams('id=r1')
    render(<ReviewPage />)
    await screen.findByText('CCC')
    await waitFor(() => expect(state.router.replace).toHaveBeenCalledWith('/review', { scroll: false }))
    expect(screen.queryByText('BB')).not.toBeInTheDocument()
  })

  it('does not reopen future highlights from a cached ahead session in normal mode', async () => {
    state.offline = true
    const today = format(new Date(), 'yyyy-MM-dd')
    state.cache = { highlights: [
      { id: 'today', highlight_id: 'h-today', date: today, rating: null, highlight: { id: 'h-today', text: 'Today only' } },
      { id: 'future', highlight_id: 'h-future', date: '2099-12-31', rating: null, highlight: { id: 'h-future', text: 'Future card' } },
    ], categories: [], pinnedHighlightIds: [] }
    render(<ReviewPage />)
    await screen.findByText('Today only')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.queryByText('Future card')).not.toBeInTheDocument()
  })
})
