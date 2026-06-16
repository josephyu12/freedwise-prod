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

export default async function ReviewLitePage() {
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
  // This month, from the 1st through today.
  const firstOfMonth = `${today.substring(0, 8)}01`

  // Text field only — the minimum payload. Unrated rows only (`rating IS NULL`)
  // so the catch-up list doesn't re-surface highlights you've already rated;
  // it's a plain column filter on this table, so it returns fewer rows, not
  // more. Paginate to stay under Supabase's 1000-row cap.
  const PAGE = 1000
  let texts: string[] = []
  let from = 0
  try {
    while (true) {
      const { data, error } = await supabase
        .from('daily_summary_highlights')
        .select('daily_summaries!inner(date), highlight:highlights!inner(text, archived)')
        .gte('daily_summaries.date', firstOfMonth)
        .lte('daily_summaries.date', today)
        .eq('daily_summaries.user_id', user.id)
        .eq('highlight.archived', false)
        .is('rating', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw error
      const list = data || []
      texts = texts.concat(list.map((sh: any) => sh.highlight?.text || '').filter(Boolean))
      if (list.length < PAGE) break
      from += PAGE
    }
  } catch {
    texts = []
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-6">
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
    </main>
  )
}
