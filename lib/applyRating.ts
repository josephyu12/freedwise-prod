/**
 * Write a rating onto a daily_summary_highlights row.
 *
 * Two devices can rate the same appearance while both are offline. Each tap is
 * stamped with a client timestamp (`rated_at`). When they sync, the EARLIER tap
 * wins — even if that device reconnects second — so last-sync-wins can't flip
 * a rating the user already gave. An intentional re-rate/clear on a row the
 * user can already see as rated (the daily page) passes `overwrite: true` and
 * always lands.
 *
 * The filter is a single UPDATE … WHERE so two replays racing on an unrated
 * row still converge: the later tap's WHERE misses once the earlier `rated_at`
 * is stored.
 */

export type HighlightRating = 'low' | 'med' | 'high' | null

export function toRatedAtIso(ratedAt: number | string): string {
  if (typeof ratedAt === 'number') return new Date(ratedAt).toISOString()
  const parsed = Date.parse(ratedAt)
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString()
}

/**
 * PostgREST `or()` clause: apply this write if the row is still unrated, or
 * if its stored `rated_at` is strictly later than this tap (we were first).
 * `rated_at` is quoted so the ISO colons aren't parsed as filter separators.
 */
export function earlierRatingWinsFilter(ratedAtIso: string): string {
  return `rating.is.null,rated_at.gt."${ratedAtIso}"`
}

export interface ApplyRatingResult {
  applied: boolean
  rating: HighlightRating
}

export async function applySummaryHighlightRating(
  supabase: any,
  params: {
    summaryHighlightId: string
    rating: HighlightRating
    ratedAt: number | string
    overwrite?: boolean
  }
): Promise<ApplyRatingResult> {
  const { summaryHighlightId, rating, overwrite } = params
  const ratedAtIso = toRatedAtIso(params.ratedAt)

  let query = supabase
    .from('daily_summary_highlights')
    .update({ rating, rated_at: ratedAtIso })
    .eq('id', summaryHighlightId)

  if (!overwrite) {
    query = query.or(earlierRatingWinsFilter(ratedAtIso))
  }

  const { data, error } = await query.select('id, rating')
  if (error) throw error
  if (data && data.length > 0) {
    return { applied: true, rating: data[0].rating ?? rating }
  }

  if (overwrite) {
    // Unconditional update matched no row — the id is gone. Treat as applied
    // so callers don't try to "keep" a rating that isn't there.
    return { applied: true, rating }
  }

  const { data: existing, error: readError } = await supabase
    .from('daily_summary_highlights')
    .select('rating')
    .eq('id', summaryHighlightId)
    .maybeSingle()
  if (readError) throw readError
  return { applied: false, rating: (existing?.rating ?? null) as HighlightRating }
}
