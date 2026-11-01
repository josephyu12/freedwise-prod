import { SupabaseClient } from '@supabase/supabase-js'

/**
 * An archived highlight must stop appearing in review from now on — including
 * days it was ALREADY portioned out to, in this cycle and in any next cycle
 * the cron pre-built. Delete those pending assignments.
 *
 * Only UNRATED rows are removed. A rated row is a review record ("rated Low on
 * Oct 12") and is kept on its day as history — the day view shows it badged
 * Archived (see lib/monthReviewStatus.ts isVisibleAssignment). That includes a
 * rating given earlier today, so archiving right after rating keeps today's
 * entry. Past unrated rows are left alone too: they're before `today`, never
 * surface in review again, and the visibility rule hides them.
 *
 * Called by every archive path: the manual Archive buttons (/review, /daily,
 * /highlights, /search, /pins), the offline archive replay, and the two-lows
 * auto-archive in lib/highlightStats.ts.
 *
 * Throws on a failed read or delete (supabase-js resolves with { error }) so
 * callers on the offline-replay path keep the action queued for a retry
 * instead of marking it done with the rows still in place.
 */
export async function removeFromFutureMonths(supabase: SupabaseClient, highlightId: string) {
  // LOCAL date, matching the localDate convention everywhere else. Every call
  // site runs in the browser, so this is the user's own "today". toISOString()
  // was UTC: archiving in a US evening (UTC already tomorrow) left today's
  // assignment for the archived highlight behind.
  const n = new Date()
  const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`

  const { data: futureSummaries, error: summariesError } = await supabase
    .from('daily_summaries')
    .select('id')
    .gte('date', today)
  if (summariesError) throw summariesError

  if (!futureSummaries || futureSummaries.length === 0) return

  const futureIds = futureSummaries.map((s: { id: string }) => s.id)

  const { error: deleteError } = await supabase
    .from('daily_summary_highlights')
    .delete()
    .eq('highlight_id', highlightId)
    .is('rating', null)
    .in('daily_summary_id', futureIds)
  if (deleteError) throw deleteError
}
