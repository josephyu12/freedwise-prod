// Text-only, server-rendered review for weak/slow connections.
//
// Unlike /review (a ~2,300-line client component that must download +
// hydrate RichTextEditor, icons, etc. before any text appears), this page is a
// server component: it fetches the highlights on the server and puts the plain
// text straight into the initial HTML. The text is visible the instant the tiny
// page lands — no big bundle, no client-side data round-trip. Rating happens via
// a plain <form> server action, so the core read-and-rate loop needs zero JS.

import Link from 'next/link'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { rateAction } from './actions'

// Always render fresh per-request — this is per-user data behind auth.
export const dynamic = 'force-dynamic'

interface LiteRow {
  id: string
  highlight_id: string
  date: string
  text: string
}

export default async function ReviewLitePage({
  searchParams,
}: {
  searchParams: { ahead?: string }
}) {
  const aheadMode = searchParams?.ahead === '1'
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-10">
        <p className="text-gray-700 dark:text-gray-300 mb-4">Please sign in to review.</p>
        <Link href="/login" className="text-blue-600 dark:text-blue-400 underline">
          Go to login
        </Link>
      </main>
    )
  }

  const today = format(new Date(), 'yyyy-MM-dd')
  const [ty, tm] = today.split('-').map(Number)
  const lastDay = new Date(ty, tm, 0).getDate()
  const firstOfMonth = `${today.substring(0, 8)}01`
  const endOfMonth = `${today.substring(0, 8)}${String(lastDay).padStart(2, '0')}`
  const upper = aheadMode ? endOfMonth : today

  // Unrated highlights only, text field only — the minimum payload. Paginate to
  // stay under Supabase's 1000-row cap.
  const PAGE = 1000
  let raw: any[] = []
  let from = 0
  let loadError = false
  try {
    while (true) {
      const { data, error } = await supabase
        .from('daily_summary_highlights')
        .select('id, highlight_id, rating, daily_summaries!inner(date), highlight:highlights!inner(id, text, archived)')
        .gte('daily_summaries.date', firstOfMonth)
        .lte('daily_summaries.date', upper)
        .eq('daily_summaries.user_id', user.id)
        .eq('highlight.archived', false)
        .is('rating', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw error
      const list = data || []
      raw = raw.concat(list)
      if (list.length < PAGE) break
      from += PAGE
    }
  } catch {
    loadError = true
  }

  const rows: LiteRow[] = raw.map((sh: any) => ({
    id: sh.id,
    highlight_id: sh.highlight_id,
    date: sh.daily_summaries?.date || '',
    text: sh.highlight?.text || '',
  }))

  const byLen = (a: LiteRow, b: LiteRow) => a.text.length - b.text.length
  const byDateThenLen = (a: LiteRow, b: LiteRow) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : byLen(a, b)

  // Today (shortest first) → overdue catch-up (oldest first) → ahead (by date).
  const todayRows = rows.filter((r) => r.date === today).sort(byLen)
  const catchUpRows = rows.filter((r) => r.date < today).sort(byDateThenLen)
  const aheadRows = aheadMode ? rows.filter((r) => r.date > today).sort(byDateThenLen) : []
  const ordered = [...todayRows, ...catchUpRows, ...aheadRows]

  return (
    <main className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
          Review — text only
        </h1>
        <Link href="/review" className="text-sm text-blue-600 dark:text-blue-400 underline">
          Full view
        </Link>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {ordered.length === 0
          ? 'Nothing to review.'
          : `${ordered.length} to review${aheadMode ? ' (through end of month)' : ''}.`}
        {' '}
        {aheadMode ? (
          <Link href="/review/lite" className="text-blue-600 dark:text-blue-400 underline">
            Just today
          </Link>
        ) : (
          <Link href="/review/lite?ahead=1" className="text-blue-600 dark:text-blue-400 underline">
            Review ahead
          </Link>
        )}
      </p>

      {loadError && (
        <p className="mb-4 px-3 py-2 rounded bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 text-sm">
          Couldn&apos;t load on this connection. Pull to refresh when you have signal.
        </p>
      )}

      {ordered.length === 0 && !loadError ? (
        <p className="text-gray-600 dark:text-gray-300">🎉 All caught up.</p>
      ) : (
        <ul className="space-y-6">
          {ordered.map((r) => (
            <li
              key={r.id}
              className="border-b border-gray-200 dark:border-gray-700 pb-5"
            >
              {r.date !== today && (
                <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
                  {r.date < today ? 'Catching up' : 'Reviewing ahead'} ·{' '}
                  {format(new Date(`${r.date}T00:00:00`), 'MMM d')}
                </div>
              )}
              <div className="whitespace-pre-wrap text-base text-gray-900 dark:text-gray-100 mb-3">
                {r.text}
              </div>
              <form action={rateAction} className="flex gap-2">
                <input type="hidden" name="summaryHighlightId" value={r.id} />
                <input type="hidden" name="highlightId" value={r.highlight_id} />
                <input type="hidden" name="summaryDate" value={r.date} />
                <button
                  type="submit"
                  name="rating"
                  value="low"
                  className="flex-1 py-2 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 font-medium"
                >
                  Low
                </button>
                <button
                  type="submit"
                  name="rating"
                  value="med"
                  className="flex-1 py-2 rounded border border-yellow-300 dark:border-yellow-700 text-yellow-700 dark:text-yellow-300 font-medium"
                >
                  Med
                </button>
                <button
                  type="submit"
                  name="rating"
                  value="high"
                  className="flex-1 py-2 rounded border border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 font-medium"
                >
                  High
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
