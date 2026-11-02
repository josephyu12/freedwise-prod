import { beforeEach, describe, expect, it } from 'vitest'
import { normalReviewRows, nextUnratedAfter, reviewResumeIndex, readReviewBookmark, writeReviewBookmark, clearReviewBookmarks } from '@/lib/reviewResume'
import { applyPendingActions } from '@/lib/pendingOverlay'

const today = '2026-11-02'
const row = (id: string, length: number, extra: any = {}) => ({
  id, highlight_id: `h-${id}`, date: today, rating: null,
  highlight: { id: `h-${id}`, text: id.repeat(length), archived: false }, ...extra,
})
const timestamp = '2026-11-02T14:00:00Z'

describe('review resume matches forward navigation', () => {
  it('reproduces the Sept 27 regression: skip A, rate B, reload at C, then wrap to A', () => {
    const rows = [row('a', 1), row('b', 2, { rating: 'high', rated_at: timestamp }), row('c', 3)]
    // The old reload and widget selection both returned a (first/shortest).
    expect(rows.findIndex((r) => r.rating === null)).toBe(0)
    expect(reviewResumeIndex(rows, today)).toBe(2)
    expect(reviewResumeIndex(rows, today)).toBe(nextUnratedAfter(rows, 1))
    rows[2] = { ...rows[2], rating: 'med', rated_at: '2026-11-02T14:01:00Z' }
    expect(reviewResumeIndex(rows, today)).toBe(0)
  })

  it('uses the most recent timestamp, not highest index, and has a legacy fallback', () => {
    const rows = [row('a', 1), row('b', 2, { rating: 'high', rated_at: timestamp }),
      row('c', 3), row('d', 4, { rating: 'low', rated_at: '2026-11-02T13:00:00Z' })]
    expect(reviewResumeIndex(rows, today)).toBe(2)
    expect(reviewResumeIndex(rows.map((r) => ({ ...r, rated_at: null })), today)).toBe(0)
    expect(reviewResumeIndex(rows.map((r) => ({ ...r, rating: 'high' })), today)).toBe(-1)
  })

  it('keeps offline rating timestamps when overlaying stale server data', () => {
    const rows = [row('a', 1), row('b', 2), row('c', 3)]
    const overlaid = applyPendingActions(rows, [{ type: 'rate-review', params: {
      summaryHighlightId: 'b', rating: 'high', ratedAt: Date.parse(timestamp),
    } }], [])
    expect(overlaid[1].rated_at).toBe(new Date(timestamp).toISOString())
    expect(reviewResumeIndex(overlaid, today)).toBe(2)
  })

  it('uses an archived rated row as an anchor without returning it or inflating counts', () => {
    const history = [row('a', 1), row('b', 2, { rating: 'low', rated_at: timestamp,
      highlight: { text: 'bb', archived: true } }), row('c', 3)]
    const visible = normalReviewRows(history, today)
    expect(visible.map((r) => r.id)).toEqual(['a', 'c'])
    expect(visible[reviewResumeIndex(visible, today, null, history)].id).toBe('c')
  })

  it('stays in today’s queue and does not inherit an ahead snapshot or yesterday’s cursor', () => {
    const history = [row('past', 1, { date: '2026-11-01', rating: 'med', rated_at: timestamp }),
      row('a', 2), row('b', 3), row('future', 1, { date: '2026-11-03' })]
    const rows = normalReviewRows(history, today)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(reviewResumeIndex(rows, today, { id: 'b', highlightId: 'h-b', date: '2026-11-01', savedAt: Date.now() }, history)).toBe(0)
  })

  it('breaks length ties identically in the widget and page', () => {
    expect(normalReviewRows([row('c', 1), row('a', 1), row('b', 1)], today).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('device navigation bookmark', () => {
  beforeEach(() => localStorage.clear())
  it('remembers a skipped-to position, scoped to owner, day, and explicit ahead mode', () => {
    const bookmark = { id: 'c', highlightId: 'h-c', date: today, savedAt: Date.parse(timestamp) + 1 }
    writeReviewBookmark('alice', false, bookmark)
    expect(readReviewBookmark('alice', today, false)).toEqual(bookmark)
    expect(readReviewBookmark('bob', today, false)).toBeNull()
    expect(readReviewBookmark('alice', today, true)).toBeNull()
    expect(readReviewBookmark('alice', '2026-11-03', false)).toBeNull()
    expect(reviewResumeIndex([row('a', 1), row('b', 2), row('c', 3)], today, bookmark)).toBe(2)
    clearReviewBookmarks()
    expect(readReviewBookmark('alice', today, false)).toBeNull()
  })

  it('lets newer server ratings supersede an old bookmark and survives new assignment IDs', () => {
    const rows = [row('a', 1), row('b', 2, { rating: 'high', rated_at: timestamp }), row('c', 3)]
    expect(reviewResumeIndex(rows, today, { id: 'a', highlightId: 'h-a', date: today, savedAt: 1 })).toBe(2)
    expect(reviewResumeIndex(rows, today, { id: 'old-c', highlightId: 'h-c', date: today, savedAt: Date.parse(timestamp) + 1 })).toBe(2)
  })
})
