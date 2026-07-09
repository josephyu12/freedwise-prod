// Shared bookkeeping for the reviewed ledger (highlight_months_reviewed) when a
// rating is CLEARED. Used by both the online /daily handler and the offline
// rate-daily replay so the two paths behave identically.

import { getCycleForDate } from './cycle'

/**
 * A rating was cleared (set to null). Drop the highlight's "reviewed" checkmark
 * for the cycle of the day it was cleared on — UNLESS the highlight still has
 * another rated day inside that same cycle (a highlight can be assigned to more
 * than one day of a multi-month cycle; clearing one shouldn't un-review the
 * cycle while another rated day remains).
 *
 * Without this, clearing a rating left the highlight_months_reviewed row behind
 * with no rating backing it — a phantom checkmark. redistribute treats
 * ledger-checked highlights as reviewed and scores their day as empty, so a day
 * holding such a highlight became a magnet for new assignments; it also inflated
 * "reviewed this cycle" counts. See app/api/daily/redistribute/route.ts.
 */
export async function removeReviewedOnClear(
  supabase: any,
  params: { userId: string; highlightId: string; summaryDate: string; freq: number }
): Promise<void> {
  const { userId, highlightId, summaryDate, freq } = params
  const cycle = getCycleForDate(summaryDate, freq)

  // Every step is error-checked and THROWS. supabase-js resolves with { error }
  // instead of rejecting, and this runs inside the offline replay: a silent
  // failure here would let the replay mark the action processed while the
  // phantom ledger row survives — the exact bug this function exists to fix.
  // (A failed summaries read must also not fall through to the delete: an empty
  // summary list would wrongly drop a checkmark another rated day still backs.)
  const { data: cycleSummaries, error: summariesError } = await supabase
    .from('daily_summaries')
    .select('id')
    .eq('user_id', userId)
    .gte('date', cycle.startDate)
    .lte('date', cycle.endDate)
  if (summariesError) throw summariesError
  const cycleSummaryIds = (cycleSummaries || []).map((s: { id: string }) => s.id)

  if (cycleSummaryIds.length > 0) {
    const { data: remaining, error: remainingError } = await supabase
      .from('daily_summary_highlights')
      .select('id')
      .eq('highlight_id', highlightId)
      .not('rating', 'is', null)
      .in('daily_summary_id', cycleSummaryIds)
      .limit(1)
    if (remainingError) throw remainingError
    if ((remaining || []).length > 0) return // still reviewed in this cycle — keep the checkmark
  }

  const { error: deleteError } = await supabase
    .from('highlight_months_reviewed')
    .delete()
    .eq('highlight_id', highlightId)
    .eq('month_year', cycle.key)
  if (deleteError) throw deleteError
}
