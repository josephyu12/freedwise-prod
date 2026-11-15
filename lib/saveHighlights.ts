import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export interface NewHighlightRow {
  id: string
  user_id: string
  text: string
  html_content: string | null
  created_at: string
  archived: false
  resurface_count: number
  average_rating: number
  rating_count: number
}

/** A retry uses the same IDs, including after a lost response or page reload. */
export async function saveHighlights(
  supabase: SupabaseClient<Database>,
  rows: NewHighlightRow[],
  categoryIds: string[]
) {
  let savedIds = new Set<string>()
  let writeError: unknown
  try {
    const { data, error } = await (supabase.from('highlights') as any)
      .upsert(rows, { onConflict: 'user_id,text_hash', ignoreDuplicates: true })
      .select('id')
    if (error) throw error
    if (!Array.isArray(data)) throw new Error('Missing save confirmation')
    savedIds = new Set(data.map((r: { id: string }) => r.id))
  } catch (error) {
    writeError = error
  }

  // Missing RETURNING rows can also be our own rows from an earlier attempt.
  // Never accept a partial verification as confirmation of the whole batch.
  const missing = rows.filter((r) => !savedIds.has(r.id))
  if (missing.length) {
    const { data, error } = await supabase.from('highlights')
      .select('id,text,html_content').eq('user_id', rows[0].user_id).in('id', missing.map((r) => r.id))
    if (error) throw error
    if (!Array.isArray(data)) throw new Error('Missing save confirmation')
    const expected = new Map(missing.map((row) => [row.id, row]))
    for (const row of data as { id: string; text: string; html_content: string | null }[]) {
      const source = expected.get(row.id)
      if (!source || row.text !== source.text || row.html_content !== source.html_content) {
        throw new Error('The saved highlight changed. Your draft has been kept.')
      }
      savedIds.add(row.id)
    }
  }
  if (writeError && savedIds.size !== rows.length) throw writeError

  const savedRows = rows.filter((r) => savedIds.has(r.id))
  if (savedRows.length && categoryIds.length) {
    const links = savedRows.flatMap((r) => categoryIds.map((id) => ({
      highlight_id: r.id, category_id: id,
    })))
    const { error } = await (supabase.from('highlight_categories') as any)
      .upsert(links, { onConflict: 'highlight_id,category_id', ignoreDuplicates: true })
    if (error) throw new Error('Highlight text is saved, but categories could not be saved. Retry to finish saving categories.')
  }
  return { savedRows, duplicateCount: rows.length - savedRows.length }
}
