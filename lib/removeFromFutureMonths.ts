import { SupabaseClient } from '@supabase/supabase-js'

export async function removeFromFutureMonths(supabase: SupabaseClient, highlightId: string) {
  const today = new Date().toISOString().split('T')[0]

  const { data: futureSummaries } = await supabase
    .from('daily_summaries')
    .select('id')
    .gt('date', today)

  if (!futureSummaries || futureSummaries.length === 0) return

  const futureIds = futureSummaries.map((s: { id: string }) => s.id)

  await supabase
    .from('daily_summary_highlights')
    .delete()
    .eq('highlight_id', highlightId)
    .in('daily_summary_id', futureIds)
}
