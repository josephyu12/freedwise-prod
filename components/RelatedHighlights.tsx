'use client'

import { useCallback, useEffect, useState } from 'react'
import { Link2, Link2Off, ChevronDown, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { isEffectivelyOffline } from '@/hooks/useManualOffline'
import { linkHighlights, unlinkHighlights } from '@/lib/highlightLinks'
import type { RelatedHighlight } from '@/app/api/highlights/[id]/related/route'

const OPEN_KEY = 'freedwise:related-open'

/**
 * "Related highlights" panel for one highlight: explicit links first, then
 * the nearest neighbours by meaning (similar_highlights RPC). Each row has a
 * Link / Unlink toggle so a good automatic match can be promoted to a saved
 * link (which then shows as "Linked to:" on the /highlights and /daily cards
 * and as a bold edge on /web).
 *
 * Network-only: renders nothing when offline or when the fetch fails, so it
 * never blocks the review flow.
 */
export default function RelatedHighlights({
  highlightId,
  className = '',
}: {
  highlightId: string
  className?: string
}) {
  const [items, setItems] = useState<RelatedHighlight[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [open, setOpen] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(OPEN_KEY)
      if (stored !== null) setOpen(stored === '1')
    } catch {
      /* default open */
    }
  }, [])

  const toggleOpen = () => {
    setOpen((prev) => {
      try {
        window.localStorage.setItem(OPEN_KEY, prev ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !prev
    })
  }

  useEffect(() => {
    let cancelled = false
    setItems(null)
    if (isEffectivelyOffline()) return
    ;(async () => {
      try {
        const res = await fetch(`/api/highlights/${highlightId}/related`)
        if (!res.ok) throw new Error(`related fetch failed: ${res.status}`)
        const data = await res.json()
        if (!cancelled) setItems(data.related || [])
      } catch (e) {
        console.warn('Related highlights unavailable:', e)
        if (!cancelled) setItems([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [highlightId])

  const toggleLink = useCallback(
    async (other: RelatedHighlight) => {
      if (busyId) return
      setBusyId(other.id)
      const wasLinked = other.linked
      // Optimistic flip; revert on failure.
      setItems((prev) =>
        prev ? prev.map((r) => (r.id === other.id ? { ...r, linked: !wasLinked } : r)) : prev
      )
      try {
        if (wasLinked) await unlinkHighlights(supabase, highlightId, other.id)
        else await linkHighlights(supabase, highlightId, other.id)
      } catch (e) {
        console.error('Failed to update highlight link:', e)
        setItems((prev) =>
          prev ? prev.map((r) => (r.id === other.id ? { ...r, linked: wasLinked } : r)) : prev
        )
      } finally {
        setBusyId(null)
      }
    },
    [busyId, highlightId, supabase]
  )

  if (!items || items.length === 0) return null

  const linkedCount = items.filter((r) => r.linked).length

  return (
    <div className={`border-t border-gray-200 dark:border-gray-700 pt-3 ${className}`}>
      <button
        onClick={toggleOpen}
        className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Related highlights
        <span className="normal-case tracking-normal font-normal">
          · {items.length}
          {linkedCount > 0 && ` · ${linkedCount} linked`}
        </span>
      </button>

      {open && (
        <ul className="mt-2 space-y-1.5">
          {items.map((r) => {
            const text = r.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
            return (
              <li
                key={r.id}
                className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${
                  r.linked
                    ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
                    : 'bg-gray-50 dark:bg-gray-800/60'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-gray-800 dark:text-gray-200 leading-snug">
                    {text.length > 180 ? `${text.slice(0, 180)}…` : text}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {r.linked ? 'Linked' : null}
                    {r.linked && r.similarity !== null ? ' · ' : null}
                    {r.similarity !== null ? `${Math.round(r.similarity * 100)}% similar` : null}
                    {(r.author || r.source) && (
                      <>
                        {' · '}
                        {r.author}
                        {r.author && r.source && ', '}
                        {r.source}
                      </>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => toggleLink(r)}
                  disabled={busyId !== null}
                  title={r.linked ? 'Remove link' : 'Link these highlights'}
                  className={`shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition disabled:opacity-50 ${
                    r.linked
                      ? 'text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800/50'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  {r.linked ? (
                    <>
                      <Link2Off className="w-3.5 h-3.5" /> Unlink
                    </>
                  ) : (
                    <>
                      <Link2 className="w-3.5 h-3.5" /> Link
                    </>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
