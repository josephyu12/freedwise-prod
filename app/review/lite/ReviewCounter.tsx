'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// Header summary line ("N to review" / "🎉 All caught up.") for the text-only
// review page.
//
// It lives client-side so the count stays live as you rate WITHOUT a full
// server refetch per tap: the hydrated rating path persists via rateOne and
// deliberately skips revalidatePath to save bandwidth on weak signal, so the
// server-rendered count would otherwise freeze until a manual refresh. Seeded
// from the server's `initialRemaining`; RateButtons dispatches a
// `lite-rated-delta` event (-1 when a row flips unrated→rated, +1 if that flip
// is rolled back) so this tracks in real time. A router.refresh() after offline
// replay updates the `initialRemaining` prop, re-seeding from the server (the
// source of truth).
export default function ReviewCounter({
  total,
  initialRemaining,
  aheadMode,
}: {
  total: number
  initialRemaining: number
  aheadMode: boolean
}) {
  const [remaining, setRemaining] = useState(initialRemaining)

  // Re-seed when the server sends a fresh count (e.g. after router.refresh()).
  useEffect(() => setRemaining(initialRemaining), [initialRemaining])

  useEffect(() => {
    const onDelta = (e: Event) => {
      const d = (e as CustomEvent<number>).detail || 0
      setRemaining((n) => Math.max(0, n + d))
    }
    window.addEventListener('lite-rated-delta', onDelta as EventListener)
    return () => window.removeEventListener('lite-rated-delta', onDelta as EventListener)
  }, [])

  return (
    <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
      {total === 0
        ? 'Nothing to review.'
        : remaining === 0
          ? '🎉 All caught up.'
          : `${remaining} to review${aheadMode ? ' (through end of month)' : ''}.`}
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
  )
}
