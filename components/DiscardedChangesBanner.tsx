'use client'

import { useEffect, useState } from 'react'
import {
  DISCARDED_CHANGES_EVENT,
  getDiscardedChanges,
  dismissDiscardedChange,
  clearDiscardedChanges,
  type DiscardedChange,
} from '@/lib/discardedChanges'

// Global, sticky warning shown when an offline change was permanently discarded
// (the server kept rejecting it until the replay loop dropped it to unblock the
// queue). Mounted once in the root layout so it surfaces on any page, and reads
// from localStorage so it survives the post-drop reload and full refreshes until
// the user dismisses it. The user's edit/rating is gone — this is the only place
// they find that out, so it must be impossible to miss and easy to act on.
export default function DiscardedChangesBanner() {
  const [items, setItems] = useState<DiscardedChange[]>([])

  useEffect(() => {
    const sync = () => setItems(getDiscardedChanges())
    sync() // initial (covers a drop that happened before mount / a refresh)
    window.addEventListener(DISCARDED_CHANGES_EVENT, sync)
    // Cross-tab: another tab's drop should show here too.
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(DISCARDED_CHANGES_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  if (items.length === 0) return null

  return (
    <div
      role="alert"
      className="w-full px-4 py-2 text-sm bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-200 border-b border-red-200 dark:border-red-900"
    >
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">
            ⚠️ {items.length} change{items.length !== 1 ? 's' : ''} couldn&apos;t be saved and{' '}
            {items.length !== 1 ? 'were' : 'was'} discarded:
          </p>
          <ul className="mt-1 space-y-0.5">
            {items.map((it) => (
              <li key={it.id} className="flex items-center justify-between gap-3">
                <span className="truncate">• {it.label}</span>
                <button
                  onClick={() => dismissDiscardedChange(it.id)}
                  className="shrink-0 underline opacity-80 hover:opacity-100"
                  aria-label={`Dismiss notice: ${it.label}`}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
        {items.length > 1 && (
          <button
            onClick={() => clearDiscardedChanges()}
            className="shrink-0 underline font-semibold self-start"
          >
            Dismiss all
          </button>
        )}
      </div>
    </div>
  )
}
