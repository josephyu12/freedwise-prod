import type { SupabaseClient } from '@supabase/supabase-js'
import type { HighlightLink } from '@/types/database'

// Explicit highlight <-> highlight links (the `highlight_links` table).
//
// Links are UNDIRECTED in the product ("these two ideas belong together"), but
// the table is a directed (from, to) pair with UNIQUE(from, to). To keep one
// row per pair we always store the lexicographically smaller id as `from`,
// and every read merges outbound + inbound rows into a single list where
// `to_highlight` is always the OTHER highlight.

export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export async function linkHighlights(supabase: SupabaseClient, a: string, b: string) {
  if (a === b) return
  const [from, to] = canonicalPair(a, b)
  const { error } = await (supabase.from('highlight_links') as any).upsert(
    { from_highlight_id: from, to_highlight_id: to },
    { onConflict: 'from_highlight_id,to_highlight_id', ignoreDuplicates: true }
  )
  if (error) throw error
}

export async function unlinkHighlights(supabase: SupabaseClient, a: string, b: string) {
  // Delete both orientations: rows written before canonical ordering existed
  // may be stored either way round.
  const { error } = await (supabase.from('highlight_links') as any)
    .delete()
    .or(
      `and(from_highlight_id.eq.${a},to_highlight_id.eq.${b}),and(from_highlight_id.eq.${b},to_highlight_id.eq.${a})`
    )
  if (error) throw error
}

// PostgREST embed shapes used by the pages' selects. `*_from` rows are links
// where this highlight is `from`, `*_to` rows are links where it is `to`.
type FromRow = {
  id: string
  to_highlight_id: string
  link_text?: string | null
  to_highlight?: { id: string; text: string; source?: string | null; author?: string | null } | null
}
type ToRow = {
  id: string
  from_highlight_id: string
  link_text?: string | null
  from_highlight?: { id: string; text: string; source?: string | null; author?: string | null } | null
}

// Merge both directions into the HighlightLink shape the cards already
// render, so an inbound link shows up on the card exactly like an outbound one.
export function normalizeLinks(
  selfId: string,
  fromRows: FromRow[] | null | undefined,
  toRows: ToRow[] | null | undefined
): HighlightLink[] {
  const out: HighlightLink[] = []
  const seen = new Set<string>()
  for (const r of fromRows || []) {
    if (seen.has(r.to_highlight_id)) continue
    seen.add(r.to_highlight_id)
    out.push({
      id: r.id,
      from_highlight_id: selfId,
      to_highlight_id: r.to_highlight_id,
      link_text: r.link_text ?? undefined,
      to_highlight: (r.to_highlight as any) ?? undefined,
    })
  }
  for (const r of toRows || []) {
    if (seen.has(r.from_highlight_id)) continue
    seen.add(r.from_highlight_id)
    out.push({
      id: r.id,
      from_highlight_id: selfId,
      to_highlight_id: r.from_highlight_id,
      link_text: r.link_text ?? undefined,
      to_highlight: (r.from_highlight as any) ?? undefined,
    })
  }
  return out
}

// Select fragments for the two embeds; keep the pages' queries in one place.
export const LINKS_FROM_SELECT = `highlight_links_from:highlight_links!from_highlight_id (
  id,
  to_highlight_id,
  link_text,
  to_highlight:highlights!to_highlight_id (id, text, source, author)
)`
export const LINKS_TO_SELECT = `highlight_links_to:highlight_links!to_highlight_id (
  id,
  from_highlight_id,
  link_text,
  from_highlight:highlights!from_highlight_id (id, text, source, author)
)`
