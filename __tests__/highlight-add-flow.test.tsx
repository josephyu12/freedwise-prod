import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const write = vi.fn()
  const saved: any[] = []
  const sb: any = { auth: {
    getSession: async () => ({ data: { session: { user: { id: 'owner' } } } }),
    getUser: async () => ({ data: { user: { id: 'owner' } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
  } }
  sb.from = (table: string) => {
    let rows: any[] | undefined
    let ids: string[] | undefined
    const q: any = {}
    for (const method of ['select', 'eq', 'order', 'range', 'gte', 'lte', 'neq', 'limit']) q[method] = () => q
    q.in = (_column: string, values: string[]) => { ids = values; return q }
    q.upsert = (values: any[]) => { rows = values; return q }
    q.then = (resolve: any, reject: any) => {
      if (table === 'highlights' && rows) return write(rows).then(resolve, reject)
      const data = table === 'highlights' ? saved.filter((r) => !ids || ids.includes(r.id)) : []
      return Promise.resolve({ data, error: null }).then(resolve, reject)
    }
    return q
  }
  return { sb, write, saved }
})
vi.mock('@/lib/supabase/client', () => ({ createClient: () => mocks.sb }))
vi.mock('@/lib/notionSyncQueue', () => ({ addToNotionSyncQueue: vi.fn(async () => {}) }))
vi.mock('@/lib/redistribute', () => ({ callRedistribute: vi.fn(async () => {}) }))
vi.mock('@/lib/cycle', async (original) => ({ ...await original<typeof import('@/lib/cycle')>(), getUserReviewSettings: async () => ({ freq: 1 }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/SimilarDraftWarning', () => ({ default: () => null }))
vi.mock('@/components/NotionSyncButton', () => ({ default: () => null }))

import Home from '@/app/page'
import Highlights from '@/app/highlights/page'

const text = 'We cannot throw away the ladder that brought us to logic.'
beforeEach(() => {
  localStorage.clear()
  mocks.saved.length = 0
  mocks.write.mockReset().mockImplementation(async (rows: any[]) => {
    const inserted = rows.filter((row) => !mocks.saved.some((old) => old.text === row.text))
    mocks.saved.push(...inserted)
    return { data: inserted.map((r) => ({ id: r.id })), error: null }
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe.each([['Home', Home], ['Highlights', Highlights]] as const)('%s real editor and save flow', (_name, Page) => {
  const mount = async () => {
    const view = render(<Page />)
    const editor = view.container.querySelector('.rich-text-editor') as HTMLElement
    await waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('true'))
    return { ...view, editor }
  }
  const type = (editor: HTMLElement) => {
    editor.innerHTML = `<p>${text}</p>`
    fireEvent.input(editor)
    fireEvent.blur(editor)
  }

  it('keeps the visible editor until confirmation, then clears it and shows Saved', async () => {
    const { editor } = await mount()
    type(editor)
    let finish!: () => void
    mocks.write.mockImplementationOnce((rows: any[]) => new Promise((resolve) => {
      finish = () => { mocks.saved.push(...rows); resolve({ data: rows.map((r) => ({ id: r.id })), error: null }) }
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Highlight' }))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce())
    expect(editor.textContent).toBe(text)
    expect(editor.getAttribute('contenteditable')).toBe('false')
    expect(screen.queryByText('Saved!')).toBeNull()
    await act(async () => { finish() })
    await waitFor(() => expect(screen.getByText('Saved!')).toBeInTheDocument())
    expect(editor.textContent).toBe('')
    expect(mocks.saved).toHaveLength(1)
  })

  it('recovers a failed mobile save after remounting and retries without duplicating content', async () => {
    const first = await mount()
    type(first.editor)
    mocks.write.mockResolvedValueOnce({ data: null, error: { message: 'network disappeared' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Highlight' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Save not confirmed'))
    expect(first.editor.textContent).toBe(text)
    first.unmount()
    const second = await mount()
    expect(second.editor.textContent).toBe(text)
    expect(screen.getByText(/Recovered your draft/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save Highlight' }))
    await waitFor(() => expect(screen.getByText('Saved!')).toBeInTheDocument())
    expect(mocks.saved).toHaveLength(1)
    expect(mocks.write.mock.calls[0][0][0].id).toBe(mocks.write.mock.calls[1][0][0].id)
    expect(second.editor.textContent).toBe('')
  })

  it('restores and retries a save interrupted while its request is still pending', async () => {
    const first = await mount()
    type(first.editor)
    mocks.write.mockImplementationOnce(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Save Highlight' }))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce())
    first.unmount() // The browser discarded the page before any acknowledgement.
    const second = await mount()
    expect(second.editor.textContent).toBe(text)
    fireEvent.click(screen.getByRole('button', { name: 'Save Highlight' }))
    await waitFor(() => expect(screen.getByText('Saved!')).toBeInTheDocument())
    expect(mocks.saved).toHaveLength(1)
    expect(mocks.write.mock.calls[1][0][0].id).toBe(mocks.write.mock.calls[0][0][0].id)
    expect(second.editor.textContent).toBe('')
  })
})
