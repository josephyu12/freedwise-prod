'use client'

// Client-side island for the text-only review page (/review/lite).
//
// The lite page is server-rendered and cached by the service worker for offline
// use. When the user rates or archives highlights on /review, the cached HTML
// goes stale — it still lists highlights that have already been handled. This
// component reads the IndexedDB offline cache and pending-action queue on
// hydration and hides those stale entries, patching the SW cache without a
// network round-trip.
//
// If IndexedDB is unavailable or the read fails, the full server-rendered list
// is shown unchanged (graceful degradation — same as before this component
// existed).

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LiteItem {
  id: string // daily_summary_highlights row ID
  highlightId: string // highlights table ID
  text: string
}

// ─── Minimal IndexedDB reader ───────────────────────────────────────────────
// Mirrors the DB schema from lib/offlineStore.ts but avoids importing it (that
// module pulls in the Supabase client, which would bloat this lightweight page).

const DB_NAME = 'freedwise-offline'
const DB_VERSION = 1

/**
 * Read the review-page cache and offline queue from IndexedDB and return the
 * set of daily_summary_highlights row IDs that have been rated, and the set of
 * highlight IDs that have been archived or deleted.
 */
function readStaleIds(): Promise<{
  ratedRowIds: Set<string>
  removedHighlightIds: Set<string>
}> {
  const ratedRowIds = new Set<string>()
  const removedHighlightIds = new Set<string>()
  const empty = { ratedRowIds, removedHighlightIds }

  if (typeof indexedDB === 'undefined') return Promise.resolve(empty)

  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(empty)
    }

    // If the DB is being created fresh, set up the expected schema so the
    // version stays in sync with lib/offlineStore.ts. Nothing to read yet.
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('highlightCache'))
        db.createObjectStore('highlightCache', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('offlineQueue'))
        db.createObjectStore('offlineQueue', { keyPath: 'id', autoIncrement: true })
    }

    req.onerror = () => resolve(empty)

    req.onsuccess = () => {
      const db = req.result

      // Guard: if the stores don't exist (e.g. future schema change), bail.
      if (
        !db.objectStoreNames.contains('highlightCache') ||
        !db.objectStoreNames.contains('offlineQueue')
      ) {
        db.close()
        return resolve(empty)
      }

      try {
        // Read both stores in a single transaction for consistency.
        const tx = db.transaction(['highlightCache', 'offlineQueue'], 'readonly')
        const cacheReq = tx.objectStore('highlightCache').get('review')
        const queueReq = tx.objectStore('offlineQueue').getAll()

        tx.oncomplete = () => {
          // 1. Cached review data — /review patches this optimistically on
          //    every rating (online AND offline), so it reflects the user's
          //    latest client-side state.
          const cached = cacheReq.result as { highlights?: any[] } | undefined
          if (cached?.highlights) {
            for (const h of cached.highlights) {
              if (h.rating != null && h.id) ratedRowIds.add(h.id)
            }
          }

          // 2. Offline queue — pending writes that haven't drained yet.
          const queue: any[] = queueReq.result || []
          for (const action of queue) {
            const p = action.params || {}
            switch (action.type) {
              case 'rate-review':
              case 'rate-daily':
                if (p.summaryHighlightId && p.rating)
                  ratedRowIds.add(p.summaryHighlightId)
                break
              case 'archive-highlight':
              case 'delete-highlight':
                if (p.highlightId) removedHighlightIds.add(p.highlightId)
                break
            }
          }

          db.close()
          resolve({ ratedRowIds, removedHighlightIds })
        }

        tx.onerror = () => {
          db.close()
          resolve(empty)
        }
      } catch {
        db.close()
        resolve(empty)
      }
    }
  })
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function LiteStaleFilter({
  items,
  aheadMode,
}: {
  items: LiteItem[]
  aheadMode: boolean
}) {
  const [visibleItems, setVisibleItems] = useState(items)

  useEffect(() => {
    let cancelled = false
    readStaleIds()
      .then(({ ratedRowIds, removedHighlightIds }) => {
        if (cancelled) return
        if (ratedRowIds.size === 0 && removedHighlightIds.size === 0) return
        setVisibleItems(
          items.filter(
            (item) =>
              !ratedRowIds.has(item.id) && !removedHighlightIds.has(item.highlightId)
          )
        )
      })
      .catch(() => {
        // Graceful degradation: stale items stay visible.
      })
    return () => {
      cancelled = true
    }
  }, [items])

  // Client-side filtering removed all items — the user has rated everything
  // since the stale HTML was cached.
  if (visibleItems.length === 0) {
    return (
      <div className="text-center py-4">
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
      </div>
    )
  }

  return (
    <>
      {aheadMode && (
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">Coming up this cycle</p>
      )}
      <ul className="divide-y divide-gray-200 dark:divide-gray-700">
        {visibleItems.map((item, i) => (
          <li
            key={`${item.id}-${i}`}
            className="py-2 whitespace-pre-wrap text-base text-gray-900 dark:text-gray-100"
          >
            {item.text}
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
    </>
  )
}
