/**
 * Covers the discarded-change notice store + banner: a permanently-dropped
 * offline change must be surfaced to the user (with a description), persist
 * across reloads, and be dismissible.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'

import {
  recordDiscardedChange,
  getDiscardedChanges,
  dismissDiscardedChange,
  clearDiscardedChanges,
  describeDiscardedAction,
  DISCARDED_CHANGES_EVENT,
} from '@/lib/discardedChanges'
import DiscardedChangesBanner from '@/components/DiscardedChangesBanner'

beforeEach(() => {
  window.localStorage.clear()
  cleanup()
})

describe('discardedChanges store', () => {
  it('persists, dedupes by id, and clears', () => {
    recordDiscardedChange({ id: 1, type: 'edit-highlight', label: 'Edit to "foo"', at: 1 })
    recordDiscardedChange({ id: 1, type: 'edit-highlight', label: 'Edit to "foo"', at: 2 }) // dup id
    recordDiscardedChange({ id: 2, type: 'rate-daily', label: 'Rating (low)', at: 3 })
    expect(getDiscardedChanges()).toHaveLength(2)

    dismissDiscardedChange(1)
    expect(getDiscardedChanges().map((e) => e.id)).toEqual([2])

    clearDiscardedChanges()
    expect(getDiscardedChanges()).toHaveLength(0)
  })

  it('survives a reload (reads back from localStorage)', () => {
    recordDiscardedChange({ id: 7, type: 'edit-highlight', label: 'Edit to "bar"', at: 1 })
    // Simulate a fresh page: a new read with no in-memory state.
    expect(getDiscardedChanges()).toEqual([
      { id: 7, type: 'edit-highlight', label: 'Edit to "bar"', at: 1 },
    ])
  })

  it('describes actions with a stripped, truncated snippet', () => {
    expect(describeDiscardedAction({ type: 'edit-highlight', params: { text: '<b>Hello</b> world' } }))
      .toBe('Edit to "Hello world"')
    expect(describeDiscardedAction({ type: 'rate-review', params: { rating: 'high' } }))
      .toBe('Rating (high)')
    expect(describeDiscardedAction({ type: 'delete-highlight', params: {} }))
      .toBe('Deleting a highlight')
    const long = describeDiscardedAction({
      type: 'edit-highlight',
      params: { text: 'x'.repeat(100) },
    })
    expect(long.endsWith('…"')).toBe(true)
  })
})

describe('DiscardedChangesBanner', () => {
  it('renders nothing when there are no discarded changes', () => {
    render(<DiscardedChangesBanner />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a notice for a discarded change and reacts to live updates', async () => {
    render(<DiscardedChangesBanner />)
    expect(screen.queryByRole('alert')).toBeNull()

    // A drop happens after mount → record + event → banner appears.
    await act(async () => {
      recordDiscardedChange({ id: 3, type: 'edit-highlight', label: 'Edit to "quote"', at: 1 })
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/Edit to "quote"/)).toBeInTheDocument()

    // Dismissing the last notice hides the banner.
    await act(async () => {
      dismissDiscardedChange(3)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows notices already present at mount (after a refresh)', () => {
    recordDiscardedChange({ id: 9, type: 'rate-daily', label: 'Rating (low)', at: 1 })
    render(<DiscardedChangesBanner />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/Rating \(low\)/)).toBeInTheDocument()
  })
})
