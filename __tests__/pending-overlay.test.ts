/**
 * Tests for the queued-write overlay (lib/pendingOverlay.ts).
 *
 * The behavior being guarded: /review no longer drains the offline queue before
 * reading the server — it reads immediately and replays the queue's intent over
 * the result, so tapping "Review ahead" after an offline stretch loads now and
 * syncs after. That's only safe if the overlay faithfully reproduces what the
 * drain would have written: ratings restored, archived/deleted rows gone, edits
 * applied. And it must be idempotent, because an action can drain in the window
 * between the snapshot and the read.
 */
import { describe, it, expect } from 'vitest'
import {
  applyPendingActions,
  applyPendingPins,
  type PendingOverlayRow,
  type PendingAction,
} from '@/lib/pendingOverlay'

const row = (id: string, highlightId: string, text = 'text'): PendingOverlayRow => ({
  id,
  highlight_id: highlightId,
  rating: null,
  highlight: { id: highlightId, text, html_content: `<p>${text}</p>`, categories: [] },
})

const ROWS: PendingOverlayRow[] = [row('r1', 'h1', 'one'), row('r2', 'h2', 'two'), row('r3', 'h3', 'three')]

describe('applyPendingActions', () => {
  it('returns rows untouched when nothing is queued', () => {
    expect(applyPendingActions(ROWS, [])).toBe(ROWS)
  })

  it('restores a rating queued offline so the row is not shown as unrated again', () => {
    const out = applyPendingActions(ROWS, [
      { type: 'rate-review', params: { summaryHighlightId: 'r2', highlightId: 'h2', rating: 'high' } },
    ])
    expect(out.map((r) => r.rating)).toEqual([null, 'high', null])
  })

  it('applies a rating queued from /daily too (same summary row)', () => {
    const out = applyPendingActions(ROWS, [
      { type: 'rate-daily', params: { summaryHighlightId: 'r1', highlightId: 'h1', rating: 'low' } },
    ])
    expect(out[0].rating).toBe('low')
  })

  it('treats a cleared rating as a value, not a missing field', () => {
    const rated = ROWS.map((r) => ({ ...r, rating: 'high' as const }))
    const out = applyPendingActions(rated, [
      { type: 'rate-daily', params: { summaryHighlightId: 'r1', highlightId: 'h1', rating: null } },
    ])
    expect(out[0].rating).toBeNull()
  })

  it('last write wins when the same row was rated twice', () => {
    const out = applyPendingActions(ROWS, [
      { type: 'rate-review', params: { summaryHighlightId: 'r1', rating: 'low' } },
      { type: 'rate-review', params: { summaryHighlightId: 'r1', rating: 'med' } },
    ])
    expect(out[0].rating).toBe('med')
  })

  it('drops highlights archived or deleted offline', () => {
    const out = applyPendingActions(ROWS, [
      { type: 'archive-highlight', params: { highlightId: 'h1' } },
      { type: 'delete-highlight', params: { highlightId: 'h3' } },
    ])
    expect(out.map((r) => r.highlight_id)).toEqual(['h2'])
  })

  it('cancels a queued archive that was later undone', () => {
    const out = applyPendingActions(ROWS, [
      { type: 'archive-highlight', params: { highlightId: 'h1' } },
      { type: 'unarchive-highlight', params: { highlightId: 'h1' } },
    ])
    expect(out.map((r) => r.highlight_id)).toEqual(['h1', 'h2', 'h3'])
  })

  it('applies an offline edit, mapping category ids to objects', () => {
    const cats = [
      { id: 'c1', name: 'Books' },
      { id: 'c2', name: 'Essays' },
    ]
    const out = applyPendingActions(
      ROWS,
      [
        {
          type: 'edit-highlight',
          params: {
            highlightId: 'h2',
            text: 'edited',
            htmlContent: '<p>edited</p>',
            source: 'A Book',
            author: 'An Author',
            categoryIds: ['c2', 'nope'],
          },
        },
      ],
      cats
    )
    expect(out[1].highlight).toMatchObject({
      text: 'edited',
      html_content: '<p>edited</p>',
      source: 'A Book',
      author: 'An Author',
      categories: [{ id: 'c2', name: 'Essays' }],
    })
    // Untouched rows keep their identity.
    expect(out[0]).toBe(ROWS[0])
  })

  it('applies the first group of an offline split to the original highlight', () => {
    const out = applyPendingActions(ROWS, [
      {
        type: 'split-highlight',
        params: {
          originalHighlightId: 'h3',
          firstGroup: { text: 'first half', html: '<p>first half</p>' },
          newGroups: [{ id: 'new', text: 'second half', html: '<p>second half</p>' }],
        },
      },
    ])
    expect(out[2].highlight?.text).toBe('first half')
    expect(out).toHaveLength(3)
  })

  it('is idempotent — an action that already drained applies to the state it produced', () => {
    const actions: PendingAction[] = [
      { type: 'rate-review', params: { summaryHighlightId: 'r1', rating: 'high' } },
      { type: 'archive-highlight', params: { highlightId: 'h2' } },
      { type: 'edit-highlight', params: { highlightId: 'h3', text: 'edited' } },
    ]
    const once = applyPendingActions(ROWS, actions)
    const twice = applyPendingActions(once, actions)
    expect(twice).toEqual(once)
  })

  it('ignores action types it has no projection for', () => {
    const out = applyPendingActions(ROWS, [{ type: 'pin-highlight', params: { highlightId: 'h1' } }])
    expect(out).toEqual(ROWS)
  })

  it('survives malformed actions without params', () => {
    const out = applyPendingActions(ROWS, [{ type: 'rate-review' }, { type: 'archive-highlight' }])
    expect(out).toEqual(ROWS)
  })
})

describe('applyPendingPins', () => {
  it('adds and removes pins queued offline', () => {
    const out = applyPendingPins(['h1'], [
      { type: 'pin-highlight', params: { highlightId: 'h2' } },
      { type: 'unpin-highlight', params: { highlightId: 'h1' } },
    ])
    expect(out).toEqual(['h2'])
  })

  it('unpins a highlight deleted offline', () => {
    expect(
      applyPendingPins(['h1'], [{ type: 'delete-highlight', params: { highlightId: 'h1' } }])
    ).toEqual([])
  })

  it('returns the input untouched when nothing is queued', () => {
    const pins = ['h1']
    expect(applyPendingPins(pins, [])).toBe(pins)
  })
})
