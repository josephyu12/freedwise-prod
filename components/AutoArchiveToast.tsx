'use client'

import { useEffect, useRef } from 'react'

const AUTO_DISMISS_MS = 10000

/**
 * Bottom-center notice shown at the moment the two-consecutive-low-cycles rule
 * auto-archives a highlight (see lib/highlightStats.ts). Without it the
 * highlight silently vanishes from future reviews — the /help page documents
 * the rule, this surfaces it when it actually fires. Undo routes to the page's
 * existing unarchive handler, which stamps unarchived_at so the low streak
 * resets (same as a manual unarchive).
 */
export default function AutoArchiveToast({
  highlightId,
  onUndo,
  onDismiss,
}: {
  highlightId: string | null
  onUndo: (highlightId: string) => void
  onDismiss: () => void
}) {
  // Auto-dismiss, keyed on highlightId so a second archive restarts the timer.
  // onDismiss lives in a ref: callers pass inline arrows, and depending on that
  // identity would restart the timer on every parent re-render.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    if (!highlightId) return
    const timer = setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [highlightId])

  if (!highlightId) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[92vw]">
      <div className="flex items-center gap-3 bg-gray-900 dark:bg-gray-700 text-white rounded-xl shadow-lg px-4 py-3 text-sm">
        <span>Rated Low two cycles in a row — highlight archived</span>
        <button
          onClick={() => onUndo(highlightId)}
          className="font-semibold text-blue-300 hover:text-blue-200 whitespace-nowrap"
        >
          Undo
        </button>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-gray-400 hover:text-gray-200"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
