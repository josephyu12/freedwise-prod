// Static "How Freedwise works" page documenting the app's implicit rules
// (auto-archive, cycle scheduling, frozen review-ahead order, …) so new users
// aren't surprised when a highlight disappears or a new one doesn't show up
// today. Every rule stated here mirrors actual behavior — if you change a rule
// in code, update its bullet here.

import Link from 'next/link'

export const metadata = {
  title: 'Help — How Freedwise Works',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-5 sm:p-6">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{title}</h2>
      <div className="space-y-2 text-sm sm:text-base text-gray-700 dark:text-gray-300 leading-relaxed">
        {children}
      </div>
    </section>
  )
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-blue-500 dark:text-blue-400 select-none">•</span>
      <p>{children}</p>
    </div>
  )
}

export default function HelpPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-3xl mx-auto">
          <div className="mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white">
              How Freedwise Works
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              The rules the app follows behind the scenes. Most of these happen
              automatically and silently — this page is where they&apos;re written down.
            </p>
          </div>

          <div className="space-y-4 sm:space-y-6">
            <Section title="Review cycles: every highlight, once per cycle">
              <Rule>
                Every active (non-archived) highlight is scheduled for review exactly{' '}
                <strong>once per cycle</strong>. The default cycle is one calendar month; you can
                change it in Settings (every 1, 2, 3, 4, 6, or 12 months).
              </Rule>
              <Rule>
                Cycles align to the calendar year. For example, a 3-month cadence always runs
                Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec — regardless of when you switched to it.
              </Rule>
              <Rule>
                Highlights are spread across the days of the cycle to balance{' '}
                <strong>total reading length</strong> (character count), not the number of
                highlights. One day might hold a single long highlight while another holds
                several short ones — that&apos;s intentional.
              </Rule>
              <Rule>
                A highlight counts as &ldquo;reviewed&rdquo; for the cycle once you rate it
                (Low / Med / High) on any of its assigned days.
              </Rule>
              <Rule>
                The next cycle&apos;s schedule is laid out automatically about a week before the
                current cycle ends.
              </Rule>
            </Section>

            <Section title="Auto-archive: two Lows in a row">
              <Rule>
                <strong>
                  If a highlight is rated Low in two consecutive cycles, it is archived
                  automatically
                </strong>{' '}
                — on the default monthly cadence, that&apos;s Low two months in a row. A brief
                notice with an Undo button appears when it happens; after that, the highlight
                simply stops appearing in reviews.
              </Rule>
              <Rule>
                The two Lows must fall in <strong>back-to-back cycles</strong>. Two Lows within
                the same cycle, or Lows separated by a cycle where you didn&apos;t rate it Low,
                do not trigger archiving.
              </Rule>
              <Rule>
                Auto-archiving is one-way: nothing is ever <em>un</em>archived automatically,
                even if you later change or clear the ratings. To bring a highlight back, use{' '}
                <Link href="/highlights" className="text-blue-600 dark:text-blue-400 underline">
                  Highlights
                </Link>{' '}
                → Show Archived → Unarchive.
              </Rule>
              <Rule>
                Unarchiving <strong>resets the streak</strong>: only Lows given after the
                unarchive count toward archiving it again. An unarchived highlight always gets
                at least two more cycles before it can be auto-archived.
              </Rule>
            </Section>

            <Section title="What archiving does">
              <Rule>
                Archiving a highlight (manually or automatically) removes it from today&apos;s
                and all future review days. Ratings you already gave it on past days are kept
                as history.
              </Rule>
              <Rule>
                If an archived highlight was sitting unrated on a past day, it no longer counts
                against that day&apos;s completion — the day can still turn green without it.
              </Rule>
              <Rule>
                Deleting a highlight removes it everywhere, including from past daily summaries.
              </Rule>
            </Section>

            <Section title="Ratings">
              <Rule>
                Ratings are worth Low = 1, Med = 2, High = 3. The average shown on a highlight
                (&ldquo;Avg: 2.4/3&rdquo;) is the mean of all its ratings ever.
              </Rule>
              <Rule>
                The <strong>Clear</strong> button removes a rating. Clearing also takes back the
                highlight&apos;s &ldquo;reviewed this cycle&rdquo; credit — unless it&apos;s
                still rated on another day of the same cycle.
              </Rule>
            </Section>

            <Section title="Adding highlights mid-cycle">
              <Rule>
                A newly added highlight is placed on days <strong>after today</strong> — it
                won&apos;t appear in today&apos;s review. (Exceptions: the very first day a
                cycle is set up, and the last day of a cycle.)
              </Rule>
              <Rule>Days you&apos;ve already fully rated never receive new highlights.</Rule>
              <Rule>
                On the last day of a cycle, any highlight that never got a slot this cycle is
                swept in so nothing is skipped. If every remaining day is already complete, new
                highlights land on the cycle&apos;s final day.
              </Rule>
            </Section>

            <Section title="The Review page">
              <Rule>
                Order on{' '}
                <Link href="/review" className="text-blue-600 dark:text-blue-400 underline">
                  Review
                </Link>
                : today&apos;s highlights first (shortest first), then <strong>catch-up</strong> —
                unrated highlights from earlier days this cycle, oldest day first.
              </Rule>
              <Rule>
                <strong>Review Ahead</strong> adds the rest of the cycle: one (shortest)
                highlight from each future day in turn, looping, so you skim across the whole
                cycle instead of grinding one day at a time.
              </Rule>
              <Rule>
                The Review Ahead order is <strong>frozen</strong> the first time it&apos;s
                computed and synced across your devices — it won&apos;t reshuffle under you.
                Highlights added later join at the end of the line.
              </Rule>
              <Rule>
                Calendar dots on the{' '}
                <Link href="/daily" className="text-blue-600 dark:text-blue-400 underline">
                  Daily
                </Link>{' '}
                page: green = every highlight that day is rated, yellow = some are.
              </Rule>
            </Section>

            <Section title="Pins">
              <Rule>
                You can pin up to <strong>10 highlights</strong>. Pinning an 11th asks you to
                choose an existing pin to replace.
              </Rule>
            </Section>

            <Section title="Settings">
              <Rule>
                Turning <strong>daily review off</strong> stops all scheduling: new highlights
                aren&apos;t placed anywhere until you turn it back on. Nothing is lost.
              </Rule>
              <Rule>
                Changing the review frequency re-arranges only the <strong>unreviewed</strong>{' '}
                remainder of the current cycle, from today forward. Everything you&apos;ve
                already rated stays exactly where it is, and switching back to a previous
                cadence restores its previous layout.
              </Rule>
              <Rule>
                &ldquo;Reset all daily highlights for this cycle&rdquo; erases the current
                cycle&apos;s ratings and schedule and redistributes from scratch. This is the
                only action that deletes ratings in bulk.
              </Rule>
            </Section>

            <Section title="Offline use">
              <Rule>
                The app works offline: ratings, archives, and edits are queued on your device
                and sync automatically when you&apos;re back online.
              </Rule>
              <Rule>
                The Wi-Fi icon in the header manually forces offline mode — useful on a weak or
                flapping connection so the app stops trying to sync mid-review.
              </Rule>
              <Rule>
                Queued offline changes live in browser storage, which the browser may evict
                after roughly a week of not opening the app. Get back online to sync before a
                long break.
              </Rule>
            </Section>

            <Section title="Notion sync & lite mode">
              <Rule>
                With Notion sync configured, every add, edit, and delete is queued automatically
                and pushed by the sync button in the header (the badge shows the pending count).
              </Rule>
              <Rule>
                On a very slow connection,{' '}
                <Link href="/review/lite" className="text-blue-600 dark:text-blue-400 underline">
                  /review/lite
                </Link>{' '}
                is a text-only, read-only version of the review list that loads almost
                instantly (add <code>?ahead=1</code> for the review-ahead list).
              </Rule>
            </Section>
          </div>
        </div>
      </div>
    </main>
  )
}
