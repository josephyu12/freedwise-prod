// THE one post-rating bookkeeping routine, shared by every rating path (the
// /review page, the /daily page, and both offline-replay branches). These used
// to carry four hand-copied variants with TWO different auto-archive policies —
// /daily archived on "2+ lows ever" while /review required "low in this cycle
// AND the previous one" — so the same highlight archived or survived depending
// on which page the rating came from. Product decision (2026-07): the /review
// rule is the rule.

import { getCycleForDate, prevCycle, cycleKeyForDate } from './cycle'

/**
 * Recompute a highlight's average_rating / rating_count and apply auto-archive
 * after a rating changes (set OR cleared).
 *
 * Archive rule: the highlight was rated 'low' in BOTH the cycle containing
 * `ratingDate` and the cycle before it — counting only lows dated after the
 * last manual unarchive. Archiving is one-way here: the flag is set when the
 * rule matches and never cleared automatically.
 *
 * Every step checks the supabase result and THROWS on failure (supabase-js
 * resolves with { error }): a silently-failed ratings read would overwrite
 * average_rating with 0, and the offline replay relies on the throw to keep
 * the action queued for retry.
 */
export async function updateHighlightStatsAfterRating(
  supabase: any,
  params: { highlightId: string; ratingDate: string; freq: number }
): Promise<void> {
  const { highlightId, ratingDate, freq } = params

  const [allRatingsRes, highlightRes, lowRatingsRes] = await Promise.all([
    supabase
      .from('daily_summary_highlights')
      .select('rating')
      .eq('highlight_id', highlightId)
      .not('rating', 'is', null),
    supabase.from('highlights').select('unarchived_at').eq('id', highlightId).single(),
    supabase
      .from('daily_summary_highlights')
      .select('rating, daily_summary:daily_summaries!inner(date)')
      .eq('highlight_id', highlightId)
      .eq('rating', 'low'),
  ])
  if (allRatingsRes.error) throw allRatingsRes.error
  if (highlightRes.error) throw highlightRes.error
  if (lowRatingsRes.error) throw lowRatingsRes.error

  const ratingMap: Record<string, number> = { low: 1, med: 2, high: 3 }
  const ratingValues = ((allRatingsRes.data || []) as Array<{ rating: string }>)
    .map((r) => ratingMap[r.rating] || 0)
    .filter((v) => v > 0)
  const average =
    ratingValues.length > 0 ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length : 0

  const unarchivedAt = (highlightRes.data as { unarchived_at?: string } | null)?.unarchived_at
    ?.split('T')[0]
  const lowCycles = new Set(
    ((lowRatingsRes.data || []) as Array<{ daily_summary: { date: string } }>)
      .filter((r) => !unarchivedAt || r.daily_summary.date > unarchivedAt)
      .map((r) => cycleKeyForDate(r.daily_summary.date, freq))
  )
  const cycle = getCycleForDate(ratingDate, freq)
  const shouldArchive = lowCycles.has(cycle.key) && lowCycles.has(prevCycle(cycle).key)

  const { error: statsError } = await supabase
    .from('highlights')
    .update({
      average_rating: average,
      rating_count: ratingValues.length,
      ...(shouldArchive ? { archived: true } : {}),
    })
    .eq('id', highlightId)
  if (statsError) throw statsError
}
