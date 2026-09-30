/**
 * Write-time similar-highlight nudge: after a typing pause the draft is
 * embedded and checked against saved highlights. Failures stay silent;
 * a real match surfaces a warning that can be dismissed or folded in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const embedText = vi.fn(async () => Array(384).fill(0.01))
  const preloadEmbedder = vi.fn(async () => true)
  const offline = { current: false }
  const update = vi.fn(() => Promise.resolve({ error: null }))
  const from = vi.fn(() => ({ update: () => ({ eq: () => update() }) }))
  return { embedText, preloadEmbedder, offline, update, from }
})

vi.mock('@/lib/clientEmbeddings', () => ({
  embedText: mocks.embedText,
  preloadEmbedder: mocks.preloadEmbedder,
  embeddingInput: (t: string) => t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
}))
vi.mock('@/hooks/useManualOffline', () => ({
  isEffectivelyOffline: () => mocks.offline.current,
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ from: mocks.from }),
}))
vi.mock('@/lib/notionSyncQueue', () => ({
  addToNotionSyncQueue: vi.fn(() => Promise.resolve()),
}))

import SimilarDraftWarning from '@/components/SimilarDraftWarning'

const LONG_DRAFT =
  'Discipline is choosing what you want most over what you want now.'

const MATCH = {
  id: 'h-1',
  text: 'Discipline is choosing what you want most over what you want right now.',
  html_content: '<p>Discipline is choosing what you want most over what you want right now.</p>',
  source: null,
  author: null,
  similarity: 0.94,
}

beforeEach(() => {
  cleanup()
  mocks.offline.current = false
  mocks.embedText.mockClear()
  mocks.update.mockClear()
  mocks.from.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ similar: [MATCH] }),
    }))
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('SimilarDraftWarning', () => {
  it('renders nothing for a short draft', () => {
    render(<SimilarDraftWarning text="too short" html="" onFolded={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(mocks.embedText).not.toHaveBeenCalled()
  })

  it('stays silent while offline', async () => {
    mocks.offline.current = true
    vi.useFakeTimers()
    render(<SimilarDraftWarning text={LONG_DRAFT} html="" onFolded={vi.fn()} />)
    await flush()
    expect(mocks.embedText).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('warns when a saved highlight says nearly the same thing', async () => {
    vi.useFakeTimers()
    render(<SimilarDraftWarning text={LONG_DRAFT} html="" onFolded={vi.fn()} />)
    await flush()
    expect(mocks.embedText).toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/highlights/similar',
      expect.objectContaining({ method: 'POST' })
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText(/you already have a highlight that says this/i)).toBeInTheDocument()
    expect(screen.getByText(/94% similar/)).toBeInTheDocument()
  })

  it('hides a match the user says is not the same idea', async () => {
    vi.useFakeTimers()
    render(<SimilarDraftWarning text={LONG_DRAFT} html="" onFolded={vi.fn()} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Not the same idea'))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('folds the draft into the saved highlight and reports the result', async () => {
    vi.useFakeTimers()
    const onFolded = vi.fn()
    render(<SimilarDraftWarning text={LONG_DRAFT} html={`<p>${LONG_DRAFT}</p>`} onFolded={onFolded} />)
    await flush()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add to it/i }))
    })
    expect(mocks.update).toHaveBeenCalled()
    expect(onFolded).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'h-1',
        text: expect.stringContaining(LONG_DRAFT),
      })
    )
  })
})
