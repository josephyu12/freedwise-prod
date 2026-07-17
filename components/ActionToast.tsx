'use client'

import { useCallback, useEffect, useState } from 'react'

const AUTO_DISMISS_MS = 2500

export type ActionToastState = { message: string; key: number } | null

/**
 * Success feedback for edit/delete/archive/pin actions. Pages call
 * showToast('Highlight deleted') at the moment the action lands (or is
 * optimistically applied / queued for offline replay) so the user isn't left
 * wondering whether anything happened before the list refreshes.
 */
export function useActionToast() {
  const [toast, setToast] = useState<ActionToastState>(null)

  // key ties the dismiss timer to each showToast call, so firing a second
  // toast while one is visible restarts the countdown instead of inheriting
  // the previous toast's remaining time.
  const showToast = useCallback((message: string) => {
    setToast({ message, key: Date.now() })
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast])

  return { toast, showToast }
}

export default function ActionToast({ toast }: { toast: ActionToastState }) {
  if (!toast) return null

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[92vw] pointer-events-none"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 bg-gray-900 dark:bg-gray-700 text-white rounded-xl shadow-lg px-4 py-3 text-sm">
        <svg
          className="w-4 h-4 text-green-400 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <span>{toast.message}</span>
      </div>
    </div>
  )
}
