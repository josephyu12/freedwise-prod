import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const save = vi.fn()
  const session = vi.fn()
  const auth = { callback: null as null | ((event: string, session: any) => void) }
  const sb = { auth: {
    getSession: session,
    onAuthStateChange: (callback: any) => { auth.callback = callback; return { data: { subscription: { unsubscribe: vi.fn() } } } },
  } }
  return { save, session, auth, sb }
})
vi.mock('@/lib/supabase/client', () => ({ createClient: () => mocks.sb }))
vi.mock('@/lib/saveHighlights', () => ({ saveHighlights: mocks.save }))
vi.mock('@/lib/notionSyncQueue', () => ({ addToNotionSyncQueue: vi.fn(async () => {}) }))
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))

import { useHighlightComposer } from '@/hooks/useHighlightComposer'
import { highlightDraftPrefix, readHighlightDrafts } from '@/lib/highlightDrafts'

const ladder = 'We cannot throw away the ladder that brought us to logic.'
const draftKey = (scope: string, user = 'owner') => `${highlightDraftPrefix(user, scope)}test-record`
const stored = (scope: string) => readHighlightDrafts(highlightDraftPrefix('owner', scope))[0]?.draft

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  mocks.session.mockResolvedValue({ data: { session: { user: { id: 'owner' } } } })
  mocks.save.mockReset().mockImplementation(async (_sb, rows) => ({ savedRows: rows, duplicateCount: 0 }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe.each(['home', 'highlights'] as const)('%s composer survives mobile interruptions', (scope) => {
  const mount = async () => {
    const hook = renderHook(() => useHighlightComposer(scope))
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    return hook
  }
  const type = (hook: Awaited<ReturnType<typeof mount>>) => act(() => hook.result.current.changeContent(ladder, `<p>${ladder}</p>`))

  it('backs up each input synchronously and restores text, formatting and categories after unmount', async () => {
    const first = await mount()
    type(first)
    act(() => first.result.current.setSelectedCategories(['cat']))
    expect(stored(scope)).toMatchObject({ text: ladder, html: `<p>${ladder}</p>`, categories: ['cat'] })
    first.unmount()
    const second = await mount()
    expect(second.result.current.text).toBe(ladder)
    expect(second.result.current.selectedCategories).toEqual(['cat'])
    expect(second.result.current.draftStatus).toMatch(/Recovered/)
  })

  it('retains the draft and reports no success while a save is pending', async () => {
    const hook = await mount()
    type(hook)
    let resolve!: (value: any) => void
    mocks.save.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    let pending!: Promise<void>
    act(() => { pending = hook.result.current.submit() })
    expect(hook.result.current.text).toBe(ladder)
    expect(hook.result.current.saveSuccess).toBe(false)
    expect(stored(scope).ids).toHaveLength(1)
    // Double taps and input events from a blurred editor cannot mutate this save.
    act(() => { void hook.result.current.submit(); hook.result.current.changeContent('new', 'new') })
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(hook.result.current.text).toBe(ladder)
    await act(async () => { resolve({ savedRows: mocks.save.mock.calls[0][1], duplicateCount: 0 }); await pending })
    expect(hook.result.current.text).toBe('')
    expect(hook.result.current.saveSuccess).toBe(true)
    expect(readHighlightDrafts(highlightDraftPrefix('owner', scope))).toHaveLength(0)
  })

  it('keeps a failed save and retries the same IDs after a page reload', async () => {
    const first = await mount()
    type(first)
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await first.result.current.submit() })
    expect(first.result.current.error).toMatch(/not confirmed/)
    expect(first.result.current.text).toBe(ladder)
    expect(first.result.current.saveSuccess).toBe(false)
    const ids = stored(scope).ids
    first.unmount()
    const second = await mount()
    await act(async () => { await second.result.current.submit() })
    expect(mocks.save.mock.calls[1][1].map((r: any) => r.id)).toEqual(ids)
    expect(second.result.current.saveSuccess).toBe(true)
  })

  it('resets retry IDs when the user edits the content', async () => {
    const hook = await mount()
    type(hook)
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await hook.result.current.submit() })
    const ids = stored(scope).ids
    act(() => hook.result.current.changeContent('edited', '<p>edited</p>'))
    await act(async () => { await hook.result.current.submit() })
    expect(mocks.save.mock.calls[1][1].map((r: any) => r.id)).not.toEqual(ids)
  })

  it('does not clear the new account draft when the previous account save resolves', async () => {
    const hook = await mount()
    type(hook)
    let resolve!: (value: any) => void
    mocks.save.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    let pending!: Promise<void>
    act(() => { pending = hook.result.current.submit() })
    localStorage.setItem(draftKey(scope, 'other'), JSON.stringify({ text: 'Other account draft', html: '', categories: [] }))
    act(() => mocks.auth.callback!('SIGNED_IN', { user: { id: 'other' } }))
    expect(hook.result.current.text).toBe('Other account draft')
    await act(async () => { resolve({ savedRows: mocks.save.mock.calls[0][1], duplicateCount: 0 }); await pending })
    expect(hook.result.current.text).toBe('Other account draft')
    expect(hook.result.current.saveSuccess).toBe(false)
    expect(stored(scope).text).toBe(ladder)
  })

  it('shows a warning if device storage fails, and still retains failed saves in the editor', async () => {
    const hook = await mount()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    type(hook)
    expect(hook.result.current.draftStatus).toMatch(/backup unavailable/)
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await hook.result.current.submit() })
    expect(hook.result.current.text).toBe(ladder)
    expect(hook.result.current.saveSuccess).toBe(false)
  })

  it('preserves drafts from separate tabs and makes both recoverable', async () => {
    const first = await mount()
    type(first)
    const second = await mount()
    expect(second.result.current.text).toBe(ladder)
    act(() => first.result.current.changeContent('First tab draft', '<p>First tab draft</p>'))
    act(() => second.result.current.changeContent('Second tab draft', '<p>Second tab draft</p>'))
    const backups = readHighlightDrafts(highlightDraftPrefix('owner', scope))
    expect(backups.map((r) => r.draft.text).sort()).toEqual(['First tab draft', 'Second tab draft'])
    await act(async () => { await second.result.current.submit() })
    expect(readHighlightDrafts(highlightDraftPrefix('owner', scope)).map((r) => r.draft.text)).toEqual(['First tab draft'])
    expect(second.result.current.otherDrafts).toHaveLength(1)
    act(() => second.result.current.recoverDraft(second.result.current.otherDrafts[0].key))
    expect(second.result.current.text).toBe('First tab draft')
    expect(second.result.current.saveSuccess).toBe(false)
  })

  it('never deletes the original backup if copying it to a restored editor fails', async () => {
    localStorage.setItem(draftKey(scope), JSON.stringify({ text: ladder, html: '', categories: [] }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const hook = await mount()
    expect(hook.result.current.text).toBe(ladder)
    expect(localStorage.getItem(draftKey(scope))).not.toBeNull()
    expect(hook.result.current.draftStatus).toMatch(/backup unavailable/)
  })

  it('does not let an old fold completion clear a changed draft', async () => {
    const hook = await mount()
    type(hook)
    const finishOldFold = hook.result.current.completeExternalSave
    act(() => hook.result.current.changeContent('New draft', '<p>New draft</p>'))
    act(() => { expect(finishOldFold()).toBe(false) })
    expect(hook.result.current.text).toBe('New draft')
    expect(stored(scope)?.text).toBe('New draft')
  })

  it('requires an identified account before editing instead of accepting unbacked anonymous drafts', async () => {
    mocks.session.mockResolvedValueOnce({ data: { session: null } })
    const hook = renderHook(() => useHighlightComposer(scope))
    await waitFor(() => expect(hook.result.current.draftStatus).toMatch(/Sign in/))
    expect(hook.result.current.ready).toBe(false)
    act(() => hook.result.current.changeContent(ladder, ladder))
    expect(hook.result.current.text).toBe('')
  })

  it('does not switch away from an unbacked draft if device storage fails', async () => {
    const hook = await mount()
    type(hook)
    localStorage.setItem(draftKey(scope), JSON.stringify({ text: 'Another draft', html: '', categories: [] }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    act(() => hook.result.current.changeContent('Unbacked latest edit', '<p>Unbacked latest edit</p>'))
    act(() => hook.result.current.recoverDraft(draftKey(scope)))
    expect(hook.result.current.text).toBe('Unbacked latest edit')
    expect(hook.result.current.error).toMatch(/before switching drafts/)
  })
})
