// Text-only, read-only highlight list for the weakest connections.
//
// The absolute-minimum view: a server component that pulls the highlights and
// drops their plain text straight into the initial HTML. No rating, no offline
// sync, no date labels, no client JS at all — nothing to download or hydrate.
// The text is visible the instant the tiny page lands, so it loads even on the
// slowest signal. For the full read-and-rate experience, use /review.

import Link from 'next/link'
import { cookies, headers } from 'next/headers'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { getUserReviewSettings, getCycleForDate } from '@/lib/cycle'

// "Today" in the user's local timezone, not the server's UTC. This is a server
// component, so a bare `new Date()` would resolve in Vercel's UTC and roll the
// date over early for users in the Americas. We resolve the zone from the `tz`
// cookie (the browser's exact IANA zone, written by app/layout.tsx) first, then
// the x-vercel-ip-timezone header (IP geolocation, covers a cold direct land),
// falling back to UTC.
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

// Always render fresh per-request — this is per-user data behind auth.
export const dynamic = 'force-dynamic'

export default async function ReviewLitePage({
  searchParams,
}: {
  // Next 14 passes a plain object here. `ahead=1` switches from the catch-up
  // list (this month through today) to the text-only "review ahead" list (the
  // remaining days of the month), mirroring /review?ahead=1.
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  const aheadMode = searchParams.ahead === '1'

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

  // Daily review off: render a calm off state instead of stale assignments.
  // This page is the read-only weak-signal fallback, so a transient settings
  // read failure degrades to the monthly defaults instead of an error page.
  let freq = 1
  let enabled = true
  try {
    ;({ freq, enabled } = await getUserReviewSettings(supabase, user.id))
  } catch {
    /* defaults */
  }
  if (!enabled) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-10 text-center">
        <p className="text-base text-gray-900 dark:text-gray-100 mb-2">Daily review is off.</p>
        <Link href="/settings" className="text-blue-600 dark:text-blue-400 underline">
          Turn it on in Settings →
        </Link>
      </main>
    )
  }

  const cycle = getCycleForDate(today, freq)
  const firstOfCycle = cycle.startDate

  // Text field only — the minimum payload. Unrated rows only (`rating IS NULL`)
  // so the list doesn't re-surface highlights you've already rated; it's a plain
  // column filter on this table, so it returns fewer rows, not more. Paginate to
  // stay under Supabase's 1000-row cap.
  //
  // Catch-up (default): the 1st through today.
  // Ahead: tomorrow through the end of the month (strictly after today).
  const PAGE = 1000
  let texts: string[] = []
  let from = 0
  try {
    while (true) {
      let query = supabase
        .from('daily_summary_highlights')
        .select('daily_summaries!inner(date), highlight:highlights!inner(text, archived)')
        .eq('daily_summaries.user_id', user.id)
        .eq('highlight.archived', false)
        .is('rating', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      query = aheadMode
        ? query.gt('daily_summaries.date', today).lte('daily_summaries.date', cycle.endDate)
        : query.gte('daily_summaries.date', firstOfCycle).lte('daily_summaries.date', today)
      const { data, error } = await query
      if (error) throw error
      const list = data || []
      texts = texts.concat(list.map((sh: any) => sh.highlight?.text || '').filter(Boolean))
      if (list.length < PAGE) break
      from += PAGE
    }
  } catch {
    texts = []
  }

  // Empty state — render a real (tiny) page instead of a blank list, so a slow
  // connection landing here when there's nothing to show isn't a white screen.
  if (texts.length === 0) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-10 text-center">
        {aheadMode ? (
          <>
            <p className="text-base text-gray-900 dark:text-gray-100 mb-4">
              Nothing scheduled for the rest of the cycle.
            </p>
            <Link href="/review/lite" className="text-blue-600 dark:text-blue-400 underline">
              Back to catch-up
            </Link>
          </>
        ) : (
          <>
            <p className="text-base text-gray-900 dark:text-gray-100 mb-4">
              You&apos;re all caught up 🎉
            </p>
            <Link
              href="/review/lite?ahead=1"
              className="text-blue-600 dark:text-blue-400 underline"
            >
              Review ahead →
            </Link>
          </>
        )}
      </main>
    )
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-6">
      {aheadMode && (
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">Coming up this cycle</p>
      )}
      <ul className="divide-y divide-gray-200 dark:divide-gray-700">
        {texts.map((text, i) => (
          <li
            key={i}
            className="py-2 whitespace-pre-wrap text-base text-gray-900 dark:text-gray-100"
          >
            {text}
          </li>
        ))}
      </ul>
      {!aheadMode && (
        <div className="mt-6 text-center">
          <Link
            href="/review/lite?ahead=1"
            className="text-sm text-blue-600 dark:text-blue-400 underline"
          >
            Review ahead →
          </Link>
        </div>
      )}
    </main>
  )
}
