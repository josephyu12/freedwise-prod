/**
 * Tests for lib/highlightLinks.ts.
 *
 * Links are undirected in the product but stored as a directed (from, to)
 * pair. These guard the two invariants the cards and /web rely on:
 *   - one canonical row per pair, regardless of which side the user tapped;
 *   - inbound and outbound rows both surface on a card, with `to_highlight`
 *     always being the OTHER highlight.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  canonicalPair,
  normalizeLinks,
  linkHighlights,
  unlinkHighlights,
} from '@/lib/highlightLinks'

describe('canonicalPair', () => {
  it('orders ids lexicographically so A->B and B->A collapse to one row', () => {
    expect(canonicalPair('b', 'a')).toEqual(['a', 'b'])
    expect(canonicalPair('a', 'b')).toEqual(['a', 'b'])
  })
})

describe('normalizeLinks', () => {
  const self = 'self'
  const fromRows = [
    { id: 'l1', to_highlight_id: 'x', link_text: null, to_highlight: { id: 'x', text: 'X' } },
  ]
  const toRows = [
    { id: 'l2', from_highlight_id: 'y', link_text: 'why', from_highlight: { id: 'y', text: 'Y' } },
  ]

  it('merges outbound and inbound rows into one list pointing at the other highlight', () => {
    const links = normalizeLinks(self, fromRows, toRows)
    expect(links.map((l) => l.to_highlight_id)).toEqual(['x', 'y'])
    expect(links.every((l) => l.from_highlight_id === self)).toBe(true)
    expect(links[1].to_highlight?.text).toBe('Y')
    expect(links[1].link_text).toBe('why')
  })

  it('dedupes a pair stored in both orientations (pre-canonical rows)', () => {
    const links = normalizeLinks(
      self,
      fromRows,
      [{ id: 'l3', from_highlight_id: 'x', from_highlight: { id: 'x', text: 'X' } }]
    )
    expect(links).toHaveLength(1)
    expect(links[0].id).toBe('l1')
  })

  it('tolerates null/undefined embeds (PostgREST omits empty relations)', () => {
    expect(normalizeLinks(self, null, undefined)).toEqual([])
  })
})

function fakeSupabase() {
  const calls: any[] = []
  const chain: any = {
    upsert: vi.fn((row: any, opts: any) => {
      calls.push({ op: 'upsert', row, opts })
      return Promise.resolve({ error: null })
    }),
    delete: vi.fn(() => chain),
    or: vi.fn((filter: string) => {
      calls.push({ op: 'delete', filter })
      return Promise.resolve({ error: null })
    }),
  }
  return { client: { from: vi.fn(() => chain) } as any, calls }
}

describe('linkHighlights / unlinkHighlights', () => {
  it('writes the canonical orientation and ignores duplicates', async () => {
    const { client, calls } = fakeSupabase()
    await linkHighlights(client, 'b', 'a')
    expect(calls[0].row).toEqual({ from_highlight_id: 'a', to_highlight_id: 'b' })
    expect(calls[0].opts).toMatchObject({
      onConflict: 'from_highlight_id,to_highlight_id',
      ignoreDuplicates: true,
    })
  })

  it('refuses to link a highlight to itself (table CHECK would reject it)', async () => {
    const { client, calls } = fakeSupabase()
    await linkHighlights(client, 'a', 'a')
    expect(calls).toHaveLength(0)
  })

  it('deletes both orientations so legacy rows are removed too', async () => {
    const { client, calls } = fakeSupabase()
    await unlinkHighlights(client, 'a', 'b')
    expect(calls[0].filter).toContain('from_highlight_id.eq.a,to_highlight_id.eq.b')
    expect(calls[0].filter).toContain('from_highlight_id.eq.b,to_highlight_id.eq.a')
  })
})
