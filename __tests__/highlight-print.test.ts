import { describe, expect, it, vi } from 'vitest'
import type { Highlight } from '@/types/database'
import { filterHighlights, type HighlightFilters } from '@/lib/highlightFilters'
import { buildHighlightPrintDocument, loadHighlightsForPrint } from '@/lib/highlightPrint'

const defaults: HighlightFilters = {
  archived: false, query: '', minRating: 0, minRatingCount: 0,
  includedCategories: [], excludedCategories: [], categoryMode: 'or', sort: 'newest',
}
const row = (id: string, overrides: Partial<Highlight> = {}): Highlight => ({
  id, text: `Highlight ${id}`, created_at: '2026-10-01', resurface_count: 0,
  average_rating: 2.5, rating_count: 3, archived: false, ...overrides,
})
const category = (id: string) => ({ id, name: id, created_at: '2026-01-01' })

describe('shared highlight filters', () => {
  const rows = [
    row('a', { author: 'Ada', categories: [category('books'), category('ideas')] }),
    row('b', { source: 'Ada essays', average_rating: 2, categories: [category('books')] }),
    row('c', { average_rating: 0, rating_count: 0 }),
    row('d', { archived: true, average_rating: 3 }),
  ]
  it('combines average/count, case-insensitive text/attribution, and category criteria', () => {
    expect(filterHighlights(rows, { ...defaults, query: ' ADA ', minRating: 2.5,
      minRatingCount: 2, includedCategories: ['books', 'ideas'], categoryMode: 'and' }).map((h) => h.id)).toEqual(['a'])
    expect(filterHighlights(rows, { ...defaults, includedCategories: ['books', 'ideas'],
      excludedCategories: ['ideas'] }).map((h) => h.id)).toEqual(['b'])
  })
  it('includes unrated only when no positive minimum is requested, and keeps archive scope', () => {
    expect(filterHighlights(rows, defaults).map((h) => h.id)).toEqual(['a', 'b', 'c'])
    expect(filterHighlights(rows, { ...defaults, minRating: 1 }).map((h) => h.id)).toEqual(['a', 'b'])
    expect(filterHighlights(rows, { ...defaults, archived: true }).map((h) => h.id)).toEqual(['d'])
    expect(filterHighlights(rows, { ...defaults, minRatingCount: 4 })).toEqual([])
  })
  it('sorts without mutating input and resolves rating ties by count, date, then ID', () => {
    const input = [row('a', { rating_count: 1 }), row('b'), row('c', { average_rating: 3 })]
    expect(filterHighlights(input, { ...defaults, sort: 'rating-high' }).map((h) => h.id)).toEqual(['c', 'b', 'a'])
    expect(filterHighlights(input, { ...defaults, sort: 'rating-low' }).map((h) => h.id)).toEqual(['b', 'a', 'c'])
    expect(input.map((h) => h.id)).toEqual(['a', 'b', 'c'])
  })
})

function clientForPages(pages: any[], failPage = -1) {
  let page = 0
  const range = vi.fn(async () => page === failPage
    ? { data: null, error: new Error('Page failed') }
    : { data: pages[page++] || [], error: null })
  const q: any = { select: vi.fn(() => q), eq: vi.fn(() => q), order: vi.fn(() => q), range }
  return { client: { auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) }, from: vi.fn(() => q) }, q }
}

describe('complete print export', () => {
  it('fetches beyond 1000 rows before filtering and never selects embeddings', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => row(String(i), { average_rating: 1 }))
    const { client, q } = clientForPages([first, [{ ...row('last'), highlight_categories: [{ category: category('books') }] }]])
    const result = await loadHighlightsForPrint(client, { ...defaults, minRating: 2, includedCategories: ['books'] })
    expect(result.map((h) => h.id)).toEqual(['last'])
    expect(q.range.mock.calls).toEqual([[0, 999], [1000, 1999]])
    expect(q.eq).toHaveBeenCalledWith('user_id', 'owner')
    expect(q.select.mock.calls[0][0]).not.toContain('*')
    expect(q.select.mock.calls[0][0]).not.toContain('embedding')
  })
  it('fails the entire export if a later page fails, and rejects signed-out users', async () => {
    const { client } = clientForPages([Array.from({ length: 1000 }, (_, i) => row(String(i)))], 1)
    await expect(loadHighlightsForPrint(client, defaults)).rejects.toThrow('Page failed')
    client.auth.getUser = async () => ({ data: { user: null }, error: null }) as any
    await expect(loadHighlightsForPrint(client, defaults)).rejects.toThrow('sign in')
  })
  it('keeps rich text and every match while escaping metadata and stripping executable HTML', () => {
    const html = buildHighlightPrintDocument([
      row('a', { html_content: '<p><strong>Bold</strong></p><ol><li>First</li></ol><script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">bad link</a>', author: '<script>author</script>' }),
      row('b', { text: 'x < y & z > 2\nSecond paragraph' }),
      row('c', { text: 'Long paragraph. '.repeat(3000) + 'THE END' }),
    ], '<img src=x onerror=alert(1)>', new Date('2026-11-02T12:00:00Z'))
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelectorAll('article')).toHaveLength(3)
    expect(doc.querySelector('strong')?.textContent).toBe('Bold')
    expect(doc.querySelector('ol li')?.textContent).toBe('First')
    expect(doc.querySelectorAll('script, img, [onerror], a[href^="javascript:"]')).toHaveLength(0)
    expect(doc.body.textContent).toContain('<script>author</script>')
    expect(doc.body.textContent).toContain('x < y & z > 2')
    expect(doc.body.textContent).toContain('THE END')
    expect(doc.querySelector('style')?.textContent).toContain('@media print')
  })
})
