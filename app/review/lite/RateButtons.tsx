'use client'

import { useEffect, useState } from 'react'
import { rateAction, rateOne } from './actions'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { enqueueOfflineAction, getPendingActions } from '@/lib/offlineStore'

type Rating = 'low' | 'med' | 'high' | null

// The Low/Med/High control for one highlight on the text-only review page.
//
// Progressive enhancement: the outer element is a real <form action={rateAction}>
// with submit buttons, so with NO JS at all it still posts to the server action
// and works online — the original zero-JS behaviour is intact. Once hydrated we
// intercept the submit to add the offline-aware path (optimistic fill, then
// either persist online via rateOne or queue the rating in IndexedDB for replay
// when the connection returns) — reusing the same offlineQueue the rich /review
// and /daily pages use, so the lite page now survives a dead connection too.
export default function RateButtons({
  summaryHighlightId,
  highlightId,
  summaryDate,
  initialRating,
}: {
  summaryHighlightId: string
  highlightId: string
  summaryDate: string
  initialRating: Rating
}) {
  const [rating, setRating] = useState<Rating>(initialRating)
  const { isOnline } = useOfflineStatus()

  // The page HTML may be served from the service-worker cache (a snapshot from
  // the last online load), so a rating made while offline wouldn't be reflected
  // in `initialRating`. Re-apply any still-pending queued rating for this
  // highlight on mount so an offline refresh doesn't drop the user's choice.
  useEffect(() => {
    let cancelled = false
    getPendingActions()
      .then((actions) => {
        const mine = actions
          .filter(
            (a) =>
              a.type === 'rate-review' &&
              a.params?.summaryHighlightId === summaryHighlightId
          )
          .pop()
        if (!cancelled && mine) setRating(mine.params.rating as Rating)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [summaryHighlightId])

  // Track a fresh server rating (e.g. after an online tap revalidates, or after
  // a successful background replay + router.refresh). Never clobber a local
  // choice back to null on a stale snapshot.
  useEffect(() => {
    if (initialRating !== null) setRating(initialRating)
  }, [initialRating])

  const queue = (value: Exclude<Rating, null>) =>
    enqueueOfflineAction({
      type: 'rate-review',
      // `today` key matches the shape app/review/page.tsx replays, so either
      // page can drain the same queue.
      params: { summaryHighlightId, highlightId, rating: value, today: summaryDate },
    })

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    // Hydrated: take over from the native server-action POST so we can handle
    // the offline case the plain form can't.
    e.preventDefault()
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    const value = submitter?.value
    if (value !== 'low' && value !== 'med' && value !== 'high') return

    const prev = rating
    setRating(value) // optimistic fill — stays put whether we save now or later

    if (!isOnline) {
      try {
        await queue(value)
      } catch {
        setRating(prev)
      }
      return
    }

    try {
      await rateOne({ summaryHighlightId, highlightId, rating: value, summaryDate })
    } catch {
      // Network died mid-tap on weak signal — fall back to the queue rather than
      // reverting; the optimistic fill is already showing.
      try {
        await queue(value)
      } catch {
        setRating(prev)
      }
    }
  }

  const base = 'flex-1 py-2 rounded border font-medium transition-colors'
  return (
    <form action={rateAction} onSubmit={handleSubmit} className="flex gap-2">
      <input type="hidden" name="summaryHighlightId" value={summaryHighlightId} />
      <input type="hidden" name="highlightId" value={highlightId} />
      <input type="hidden" name="summaryDate" value={summaryDate} />
      <button
        type="submit"
        name="rating"
        value="low"
        aria-pressed={rating === 'low'}
        className={`${base} ${
          rating === 'low'
            ? 'border-red-600 bg-red-600 text-white'
            : 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-300'
        }`}
      >
        Low
      </button>
      <button
        type="submit"
        name="rating"
        value="med"
        aria-pressed={rating === 'med'}
        className={`${base} ${
          rating === 'med'
            ? 'border-yellow-500 bg-yellow-500 text-white'
            : 'border-yellow-300 dark:border-yellow-700 text-yellow-700 dark:text-yellow-300'
        }`}
      >
        Med
      </button>
      <button
        type="submit"
        name="rating"
        value="high"
        aria-pressed={rating === 'high'}
        className={`${base} ${
          rating === 'high'
            ? 'border-green-600 bg-green-600 text-white'
            : 'border-green-300 dark:border-green-700 text-green-700 dark:text-green-300'
        }`}
      >
        High
      </button>
    </form>
  )
}
