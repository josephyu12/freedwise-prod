import { describe, it, expect, vi } from 'vitest'
import { saveHighlights, type NewHighlightRow } from '@/lib/saveHighlights'

const rows: NewHighlightRow[] = ['a', 'b'].map((id) => ({
  id, user_id: 'owner', text: id, html_content: id, archived: false,
  created_at: '2026-11-14T12:00:00.000Z', resurface_count: 0, average_rating: 0, rating_count: 0,
}))

function client(write: any, verify: any = { data: [], error: null }, categories: any = { error: null }) {
  const categoryUpsert = vi.fn(async () => categories)
  const verification = { select: vi.fn(), eq: vi.fn(), in: vi.fn(async () => verify) }
  verification.select.mockReturnValue(verification)
  verification.eq.mockReturnValue(verification)
  const sb: any = { from: vi.fn((table) => table === 'highlight_categories'
    ? { upsert: categoryUpsert }
    : { ...verification, upsert: () => ({ select: async () => {
      if (write instanceof Error) throw write
      return write
    } }) }) }
  return { sb, categoryUpsert, verification }
}

describe('confirmed highlight saves', () => {
  it('returns all saved rows after a confirmed write', async () => {
    const { sb, verification } = client({ data: rows, error: null })
    expect(await saveHighlights(sb, rows, [])).toEqual({ savedRows: rows, duplicateCount: 0 })
    expect(verification.in).not.toHaveBeenCalled()
  })

  it('recovers every row after a committed write loses its response and finishes categories', async () => {
    const { sb, categoryUpsert } = client(new Error('connection lost'), { data: rows, error: null })
    expect((await saveHighlights(sb, rows, ['category'])).savedRows).toEqual(rows)
    expect(categoryUpsert).toHaveBeenCalledWith(rows.map((r) => ({ highlight_id: r.id, category_id: 'category' })),
      { onConflict: 'highlight_id,category_id', ignoreDuplicates: true })
  })

  it('rejects partial recovery instead of discarding the rest of a batch', async () => {
    const { sb } = client({ data: null, error: { message: 'timeout' } }, { data: [rows[0]], error: null })
    await expect(saveHighlights(sb, rows, [])).rejects.toEqual({ message: 'timeout' })
  })

  it('does not turn verification errors into an empty successful result', async () => {
    const { sb } = client(new Error('timeout'), { data: null, error: { message: 'offline' } })
    await expect(saveHighlights(sb, rows, [])).rejects.toEqual({ message: 'offline' })
  })

  it('treats already committed retry IDs as saved and attaches their categories', async () => {
    const { sb, categoryUpsert, verification } = client({ data: [], error: null }, { data: rows, error: null })
    expect((await saveHighlights(sb, rows, ['category'])).duplicateCount).toBe(0)
    expect(verification.eq).toHaveBeenCalledWith('user_id', 'owner')
    expect(categoryUpsert).toHaveBeenCalled()
  })

  it('distinguishes genuine duplicates from rows inserted by this attempt', async () => {
    const { sb } = client({ data: [rows[0]], error: null })
    expect(await saveHighlights(sb, rows, [])).toEqual({ savedRows: [rows[0]], duplicateCount: 1 })
  })

  it('reports category errors that Supabase resolves rather than throws', async () => {
    const { sb } = client({ data: rows, error: null }, undefined, { error: { message: 'unreachable' } })
    await expect(saveHighlights(sb, rows, ['category'])).rejects.toThrow(/text is saved, but categories/)
  })

  it('rejects a missing write acknowledgement', async () => {
    const { sb } = client({ data: null, error: null })
    await expect(saveHighlights(sb, rows, [])).rejects.toThrow('Missing save confirmation')
  })

  it('does not clear a draft when a recovered ID now has different content', async () => {
    const { sb } = client(new Error('timeout'), { data: rows.map((r) => ({ ...r, text: 'different edit' })), error: null })
    await expect(saveHighlights(sb, rows, [])).rejects.toThrow(/saved highlight changed/)
  })
})
