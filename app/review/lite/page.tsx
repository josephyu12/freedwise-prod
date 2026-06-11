// Text-only, server-rendered review for weak/slow connections.
//
// Unlike /review (a ~2,300-line client component that must download +
// hydrate RichTextEditor, icons, etc. before any text appears), this page is a
// server component: it fetches the highlights on the server and puts the plain
// text straight into the initial HTML. The text is visible the instant the tiny
// page lands — no big bundle, no client-side data round-trip. Rating happens via
// a plain <form> server action, so the core read-and-rate loop needs zero JS.

import Link from 'next/link'
import { cookies, headers } from 'next/headers'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import RateButtons from './RateButtons'
import LiteOfflineSync from './LiteOfflineSync'
import ReviewCounter from './ReviewCounter'

// Always render fresh per-request — this is per-user data behind auth.
export const dynamic = 'force-dynamic'

type Rating = 'low' | 'med' | 'high' | null

interface LiteRow {
  id: string
  highlight_id: string
  date: string
  text: string
  rating: Rating
}

// "Today" in the user's local timezone, not the server's UTC. This page is a
// server component, so a bare `new Date()` would resolve the date in Vercel's
// UTC and roll over hours early for users in the Americas — surfacing the wrong
// day's highlights at night.
//
// We resolve the zone from two sources, best first:
//   1. The `tz` cookie — the browser's exact IANA zone, written by an inline
//      script in app/layout.tsx on any prior page load. Authoritative because
//      it's the device's real setting (matches the client `new Date()` the rest
//      of the app relies on).
//   2. The `x-vercel-ip-timezone` request header — IP geolocation Vercel adds
//      to every request. Covers the cold-start case (a fresh browser landing
//      directly on this URL, before the cookie exists) with zero extra JS.
// Only if neither is present do we fall back to UTC.
function localToday(tz: string | undefined): string {
  try {
    // en-CA renders as YYYY-MM-DD, which is exactly our wire format.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    return format(new Date(), 'yyyy-MM-dd')
  }
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

  const cookieTz = (await cookies()).get('tz')?.value
  const ipTz = (await headers()).get('x-vercel-ip-timezone') || undefined
  const today = localToday(cookieTz || ipTz)
  const [ty, tm] = today.split('-').map(Number)
  const lastDay = new Date(ty, tm, 0).getDate()
  const firstOfMonth = `${today.substring(0, 8)}01`
  const endOfMonth = `${today.substring(0, 8)}${String(lastDay).padStart(2, '0')}`
  // Default mode: this month up to today (today + earlier-day catch-up).
  // Ahead mode: today onwards through end of month — no earlier-month catch-up,
  // so getting ahead doesn't drag the whole month back into view.
  const lower = aheadMode ? today : firstOfMonth
  const upper = aheadMode ? endOfMonth : today

  // Text field only — the minimum payload. We fetch rated rows too (not just
  // unrated): a just-rated highlight must stay on the page with its rating
  // filled in rather than vanish the instant you tap a button, matching
  // /review. Paginate to stay under Supabase's 1000-row cap.
  const PAGE = 1000
  let raw: any[] = []
  let from = 0
  let loadError = false
  try {
    while (true) {
      const { data, error } = await supabase
        .from('daily_summary_highlights')
        .select('id, highlight_id, rating, daily_summaries!inner(date), highlight:highlights!inner(id, text, archived)')
        .gte('daily_summaries.date', lower)
        .lte('daily_summaries.date', upper)
        .eq('daily_summaries.user_id', user.id)
        .eq('highlight.archived', false)
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
    rating: (sh.rating ?? null) as Rating,
  }))

  const byLen = (a: LiteRow, b: LiteRow) => a.text.length - b.text.length
  const byDateThenLen = (a: LiteRow, b: LiteRow) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : byLen(a, b)

  // Ordering: today (shortest first) → earlier-day catch-up (oldest first) →
  // ahead (by date, ahead mode only). Every bucket keeps BOTH rated and unrated
  // rows so nothing vanishes the moment you tap a rating — the row just stays
  // put with its choice filled in. The sorts are rating-agnostic (length / date,
  // not rating), so a row holds its position across the re-render that follows a
  // rating instead of jumping. (This is intentionally more persistent than
  // /review's in-memory list, which re-buckets unrated-only on a hard reload.)
  const todayRows = rows.filter((r) => r.date === today).sort(byLen)
  // Earlier-day catch-up only in default mode; ahead mode is today-onwards.
  const catchUpRows = aheadMode ? [] : rows.filter((r) => r.date < today).sort(byDateThenLen)
  const aheadRows = aheadMode ? rows.filter((r) => r.date > today).sort(byDateThenLen) : []
  const ordered = [...todayRows, ...catchUpRows, ...aheadRows]

  // Items still needing a rating — drives the header count + caught-up banner,
  // while the list itself renders rated rows too so they don't vanish.
  const remaining = ordered.filter((r) => r.rating === null).length

  return (
    <main className="max-w-2xl mx-auto px-4 py-6">
      <LiteOfflineSync />
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
          Review — text only
        </h1>
        <Link href="/review" className="text-sm text-blue-600 dark:text-blue-400 underline">
          Full view
        </Link>
      </div>
      <ReviewCounter
        total={ordered.length}
        initialRemaining={remaining}
        aheadMode={aheadMode}
      />

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
              <RateButtons
                summaryHighlightId={r.id}
                highlightId={r.highlight_id}
                summaryDate={r.date}
                initialRating={r.rating}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
