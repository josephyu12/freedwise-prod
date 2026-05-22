/**
 * Regression test for the false "Already added — duplicate skipped." notice.
 *
 * Root cause: in app/page.tsx the `saving` re-entry flag was only set with
 * setSaving(true) *after* `await supabase.auth.getUser()`. A second submit
 * fired during that auth round-trip (double-click / double-tap) sailed past
 * the `if (saving) return` guard, ran a second insert, and that insert
 * collided with the first on the (user_id, text_hash) unique constraint —
 * surfacing a "duplicate" notice for a highlight that was never a duplicate.
 *
 * The fix is a synchronous `useRef` guard set before the await.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// Shared mock state, created in a hoisted block so the vi.mock factories
// below (which are hoisted above imports) can reference it safely.
const mocks = vi.hoisted(() => {
  const upsertCalls: any[][] = []
  const insertedHashes = new Set<string>()
  const normalize = (t: string) =>
    (t || '').trim().toLowerCase().replace(/\s+/g, ' ')

  // Models the real /auth/v1/user network round-trip getUser() performs.
  // The double-submit race lives entirely inside this delay window.
  const getUser = vi.fn(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ data: { user: { id: 'user-1' } }, error: null }),
          25
        )
      )
  )

  const makeBuilder = (table: string) => {
    let upsertRows: any[] | null = null
    const b: any = {
      select: vi.fn(() => b),
      eq: vi.fn(() => b),
      neq: vi.fn(() => b),
      order: vi.fn(() => b),
      range: vi.fn(() => b),
      insert: vi.fn(() => b),
      update: vi.fn(() => b),
      upsert: vi.fn((rows: any[]) => {
        upsertRows = rows
        if (table === 'highlights') upsertCalls.push(rows)
        return b
      }),
      catch: () => Promise.resolve(),
      then: (resolve: any, reject: any) => {
        // Simulate the Postgres (user_id, text_hash) unique constraint:
        // rows whose normalized text was already inserted are dropped.
        if (table === 'highlights' && upsertRows) {
          const inserted = upsertRows
            .filter((r) => {
              const hash = normalize(r.text)
              if (insertedHashes.has(hash)) return false
              insertedHashes.add(hash)
              return true
            })
            .map((r) => ({ id: r.id }))
          return Promise.resolve({ data: inserted, error: null }).then(
            resolve,
            reject
          )
        }
        return Promise.resolve({ data: [], error: null }).then(resolve, reject)
      },
    }
    return b
  }

  const supabase = {
    auth: { getUser },
    from: vi.fn((table: string) => makeBuilder(table)),
  }

  return { upsertCalls, insertedHashes, getUser, supabase }
})

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => mocks.supabase,
}))
vi.mock('@/lib/notionSyncQueue', () => ({
  addToNotionSyncQueue: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/lib/redistribute', () => ({
  callRedistribute: vi.fn(() => Promise.resolve()),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}))
vi.mock('next/link', () => ({
  default: (props: any) => props.children,
}))
// Minimal RichTextEditor stand-in: a textarea that pipes its value back out
// the same (text, html) way the real component's onChange does.
vi.mock('@/components/RichTextEditor', async () => {
  const React = await import('react')
  return {
    default: (props: any) =>
      React.createElement('textarea', {
        'data-testid': 'editor',
        value: props.value ?? '',
        placeholder: props.placeholder,
        onChange: (e: any) => props.onChange(e.target.value, e.target.value),
      }),
  }
})

import Home from '@/app/page'

const settle = () =>
  act(async () => {
    // 200ms > the 25ms getUser delay, so any submit that got through has
    // fully completed (auth round-trip + insert) by the time we assert.
    await new Promise((r) => setTimeout(r, 200))
  })

const submitButton = (container: HTMLElement) =>
  container.querySelector('button[type="submit"]') as HTMLButtonElement

describe('Home — add-highlight double-submit guard', () => {
  beforeEach(() => {
    mocks.upsertCalls.length = 0
    mocks.insertedHashes.clear()
    mocks.getUser.mockClear()
    mocks.supabase.from.mockClear()
  })

  it('inserts exactly once when Save is double-clicked, with no false duplicate notice', async () => {
    const { container } = render(<Home />)

    const editor = screen.getByTestId('editor')
    fireEvent.change(editor, {
      target: { value: 'a genuinely new highlight' },
    })

    const save = submitButton(container)
    expect(save).not.toBeDisabled()

    // Two submits landing inside the getUser() auth window — the exact
    // double-click / impatient double-tap that produced the false notice.
    fireEvent.click(save)
    fireEvent.click(save)

    await settle()

    // The ref guard rejects the second submit synchronously: one insert,
    // and no "duplicate" notice anywhere on screen.
    expect(mocks.upsertCalls).toHaveLength(1)
    expect(screen.queryByText(/duplicate/i)).toBeNull()
  })

  it('still flags a genuine duplicate on a separate, later submit', async () => {
    const { container } = render(<Home />)
    const editor = screen.getByTestId('editor')

    // First submit — runs to completion, ref guard released afterward.
    fireEvent.change(editor, { target: { value: 'repeated text' } })
    fireEvent.click(submitButton(container))
    await settle()
    expect(mocks.upsertCalls).toHaveLength(1)

    // Second, independent submit of the same text must still be caught.
    fireEvent.change(editor, { target: { value: 'repeated text' } })
    fireEvent.click(submitButton(container))
    await settle()

    expect(mocks.upsertCalls).toHaveLength(2)
    expect(screen.getByText(/duplicate/i)).toBeInTheDocument()
  })
})
