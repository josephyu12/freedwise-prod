// Server-side highlight rating + bookkeeping for the text-only /review/lite
// flow. Mirrors the critical path in app/review/page.tsx's handleRate +
// updateHighlightStats, but runs entirely on the server (no optimistic UI, no
// offline queue) so the lite page can rate via a plain <form> server action
// with zero client JS — the point of the weak-signal mode.

type Rating = 'low' | 'med' | 'high'

export async function rateHighlightServer(
  // The server Supabase client (RLS-scoped to the signed-in user).
  supabase: any,
  params: {
    summaryHighlightId: string
    highlightId: string
    rating: Rating
    // The date (YYYY-MM-DD) of the daily summary this assignment belongs to.
    // The review month is derived from this, matching /daily's behavior so a
    // catch-up/ahead day records its own month rather than "today".
    summaryDate: string
  }
) {
  const { summaryHighlightId, highlightId, rating, summaryDate } = params
  const [y, mo] = summaryDate.split('-').map(Number)
  const monthYear = `${y}-${String(mo).padStart(2, '0')}`

  // Critical path: save the rating AND mark this month reviewed. RLS ensures the
  // update only touches rows the user owns, so the id alone is a safe key.
  const { error: rateError } = await supabase
    .from('daily_summary_highlights')
    .update({ rating })
    .eq('id', summaryHighlightId)
  if (rateError) throw rateError

  const { error: reviewedError } = await supabase
    .from('highlight_months_reviewed')
    .upsert(
      { highlight_id: highlightId, month_year: monthYear },
      { onConflict: 'highlight_id,month_year' }
    )
  if (reviewedError) throw reviewedError

  // Recompute derived stats + auto-archive (archive when rated 'low' in both
  // this month and the previous one), matching app/review/page.tsx.
  const [allRatingsRes, highlightRes, lowRatingsRes] = await Promise.all([
    supabase
      .from('daily_summary_highlights')
      .select('rating')
      .eq('highlight_id', highlightId)
      .not('rating', 'is', null),
    supabase
      .from('highlights')
      .select('unarchived_at')
      .eq('id', highlightId)
      .single(),
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
    ratingValues.length > 0
      ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
      : 0

  const unarchivedAt = (highlightRes.data as any)?.unarchived_at?.split('T')[0]
  const lowMonths = new Set(
    ((lowRatingsRes.data || []) as Array<{ rating: string; daily_summary: { date: string } }>)
      .filter((r) => !unarchivedAt || r.daily_summary.date > unarchivedAt)
      .map((r) => r.daily_summary.date.substring(0, 7))
  )
  const prevMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
  const shouldArchive = lowMonths.has(monthYear) && lowMonths.has(prevMonth)

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
