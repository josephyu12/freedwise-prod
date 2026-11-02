import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HighlightPrintButton from '@/components/HighlightPrintButton'
import type { HighlightFilters } from '@/lib/highlightFilters'

const state = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/highlightPrint', async (original) => ({ ...(await original<any>()), loadHighlightsForPrint: state.load }))
const filters: HighlightFilters = { archived: false, query: '', minRating: 2.5, minRatingCount: 1, includedCategories: [], excludedCategories: [], categoryMode: 'or', sort: 'rating-high' }
afterEach(() => vi.restoreAllMocks())

it('shows a recoverable message when the preview popup is blocked', () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  render(<HighlightPrintButton filters={filters} categories={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Print / PDF' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Allow pop-ups')
})

it('opens before the asynchronous load and wires the preview print action', async () => {
  let resolve: (rows: any[]) => void
  state.load.mockReturnValue(new Promise((r) => { resolve = r }))
  const doc = document.implementation.createHTMLDocument()
  const preview = { document: doc, closed: false, opener: window, focus: vi.fn(), print: vi.fn() }
  const open = vi.spyOn(window, 'open').mockReturnValue(preview as any)
  render(<HighlightPrintButton filters={filters} categories={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Print / PDF' }))
  expect(open).toHaveBeenCalledTimes(1)
  expect(doc.body.textContent).toContain('Preparing')
  resolve!([{ id: 'h', text: 'Exported idea', created_at: '2026-01-01', average_rating: 3, rating_count: 1, resurface_count: 0 }])
  await waitFor(() => expect(doc.querySelector('article')).not.toBeNull())
  expect(doc.body.textContent).toContain('Average rating ≥ 2.5/3')
  doc.getElementById('print-highlights')!.click()
  expect(preview.print).toHaveBeenCalledTimes(1)
  expect(preview.opener).toBeNull()
})
