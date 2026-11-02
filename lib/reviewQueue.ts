import { normalReviewRows, reviewResumeIndex, type ResumeRow } from './reviewResume'

interface QueueRow extends ResumeRow {
  highlight: {
    text: string
    html_content?: string | null
    source?: string | null
    author?: string | null
    archived?: boolean | null
  } | null
}

// Shared by both read-only next-highlight endpoints. Include rated rows as
// resume anchors, then select the next unrated row using the page's rule.
export async function loadReviewQueue(supabase: any, userId: string, today: string, cycleStart: string) {
  const history: QueueRow[] = []
  const PAGE = 1000
  const readRange = async (start: string, beforeToday: boolean) => {
    for (let from = 0; ; from += PAGE) {
      let query = supabase.from('daily_summary_highlights')
        .select(`id, highlight_id, rating, rated_at,
          daily_summary:daily_summaries!inner(id, date, user_id),
          highlight:highlights!inner(id, text, html_content, source, author, archived, user_id)`)
        .eq('daily_summary.user_id', userId)
        .eq('highlight.user_id', userId)
        .gte('daily_summary.date', start)
      query = beforeToday ? query.lt('daily_summary.date', today) : query.lte('daily_summary.date', today)
      const { data, error } = await query
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw error
      const page = data || []
      history.push(...page.map((r: any) => ({ ...r, date: r.daily_summary.date })))
      if (page.length < PAGE) break
    }
  }
  // Most widget refreshes only need one day's data. Fetch the older cycle
  // rows only after today's active cards are complete (or there is no day).
  await readRange(today, false)
  if (!history.some((r) => r.rating === null && r.highlight && !r.highlight.archived) && cycleStart < today) {
    await readRange(cycleStart, true)
  }
  const rows = normalReviewRows(history, today)
  const todaysRows = rows.filter((r) => r.date === today)
  const index = reviewResumeIndex(rows, today, null, history)
  const pick = rows[index]
  return {
    highlight: pick ? {
      summaryHighlightId: pick.id,
      highlightId: pick.highlight_id,
      text: pick.highlight?.text || '',
      htmlContent: pick.highlight?.html_content || null,
      source: pick.highlight?.source || null,
      author: pick.highlight?.author || null,
    } : null,
    total: todaysRows.length,
    reviewed: todaysRows.filter((r) => r.rating !== null).length,
    allDone: !pick,
    ...(pick && pick.date < today ? { catchUpDate: pick.date } : {}),
  }
}
