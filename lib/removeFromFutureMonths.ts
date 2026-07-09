import { SupabaseClient } from '@supabase/supabase-js'

export async function removeFromFutureMonths(supabase: SupabaseClient, highlightId: string) {
  // LOCAL date, matching the localDate convention everywhere else. Both call
  // sites (review page, offline replay) run in the browser, so this is the
  // user's own "today". toISOString() was UTC: archiving in a US evening (UTC
  // already tomorrow) left today's assignment for the archived highlight behind.
  const n = new Date()
  const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`

  const { data: futureSummaries } = await supabase
    .from('daily_summaries')
    .select('id')
    .gte('date', today)

  if (!futureSummaries || futureSummaries.length === 0) return

  const futureIds = futureSummaries.map((s: { id: string }) => s.id)

  await supabase
    .from('daily_summary_highlights')
    .delete()
    .eq('highlight_id', highlightId)
    .in('daily_summary_id', futureIds)
}
