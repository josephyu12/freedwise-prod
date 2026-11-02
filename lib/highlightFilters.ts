import type { Highlight } from '@/types/database'

export type HighlightSort = 'newest' | 'oldest' | 'rating-high' | 'rating-low'

export interface HighlightFilters {
  archived: boolean
  query: string
  minRating: number
  minRatingCount: number
  includedCategories: string[]
  excludedCategories: string[]
  categoryMode: 'or' | 'and'
  sort: HighlightSort
}

export function ratingValue(highlight: { average_rating?: number | null }) {
  const value = Number(highlight.average_rating)
  return Number.isFinite(value) ? value : 0
}

export function ratingCount(highlight: { rating_count?: number | null }) {
  const count = Number(highlight.rating_count)
  return Number.isFinite(count) && count > 0 ? count : 0
}

// Shared by the paginated library and the full print export. Filter before
// pagination; minimum rating means average on the low=1/med=2/high=3 scale.
export function filterHighlights<T extends Highlight>(rows: T[], filters: HighlightFilters): T[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return rows.filter((h) => {
    if (!!h.archived !== filters.archived) return false
    if (filters.minRating > 0 && (ratingCount(h) === 0 || ratingValue(h) < filters.minRating)) return false
    if (ratingCount(h) < filters.minRatingCount) return false
    if (query && ![h.text, h.source, h.author].some((s) => s?.toLocaleLowerCase().includes(query))) return false
    const categories = new Set(h.categories?.map((c) => c.id) || [])
    if (filters.excludedCategories.some((id) => categories.has(id))) return false
    if (filters.includedCategories.length) {
      const matches = (id: string) => categories.has(id)
      if (filters.categoryMode === 'and'
        ? !filters.includedCategories.every(matches)
        : !filters.includedCategories.some(matches)) return false
    }
    return true
  }).sort((a, b) => {
    const createdDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    if (filters.sort === 'oldest') return createdDiff || a.id.localeCompare(b.id)
    if (filters.sort === 'rating-high' || filters.sort === 'rating-low') {
      const ratingDiff = filters.sort === 'rating-high'
        ? ratingValue(b) - ratingValue(a) : ratingValue(a) - ratingValue(b)
      if (ratingDiff) return ratingDiff
      const countDiff = ratingCount(b) - ratingCount(a)
      if (countDiff) return countDiff
    }
    return -createdDiff || a.id.localeCompare(b.id)
  })
}

export function describeHighlightFilters(filters: HighlightFilters, categories: { id: string; name: string }[]): string {
  const name = (id: string) => categories.find((c) => c.id === id)?.name || id
  const parts = [filters.archived ? 'Archived highlights' : 'Active highlights']
  if (filters.query.trim()) parts.push(`Contains: “${filters.query.trim()}”`)
  if (filters.minRating > 0) parts.push(`Average rating ≥ ${filters.minRating}/3`)
  if (filters.minRatingCount > 0) parts.push(`Ratings ≥ ${filters.minRatingCount}`)
  if (filters.includedCategories.length) parts.push(`${filters.categoryMode === 'and' ? 'All' : 'Any'} categories: ${filters.includedCategories.map(name).join(', ')}`)
  if (filters.excludedCategories.length) parts.push(`Exclude: ${filters.excludedCategories.map(name).join(', ')}`)
  const sorts: Record<HighlightSort, string> = {
    newest: 'Newest first', oldest: 'Oldest first', 'rating-high': 'Highest rated first', 'rating-low': 'Lowest rated first',
  }
  parts.push(sorts[filters.sort])
  return parts.join(' · ')
}
