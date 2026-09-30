'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CornerDownRight, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { embedText, embeddingInput, preloadEmbedder } from '@/lib/clientEmbeddings'
import { isEffectivelyOffline } from '@/hooks/useManualOffline'
import { combineHighlights } from '@/lib/combineHighlights'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import type { SimilarSavedHighlight } from '@/app/api/highlights/similar/route'

// Don't bother the model (or the user) with a half-typed sentence.
const MIN_CHARS = 30
// Typing pause before a check runs. Embedding is ~50ms once the model is
// warm; the wait is about not flickering suggestions under a moving cursor.
const DEBOUNCE_MS = 800
// At/above this the header stops hedging.
const DUPLICATE_SIMILARITY = 0.93

export type FoldedResult = { id: string; text: string; html: string }

/**
 * Write-time duplicate nudge for the add-highlight forms. While the user
 * types, the draft is embedded in the browser (gte-small, same model as
 * search) and checked against the saved library; anything that says nearly
 * the same thing is listed under the editor with two ways out:
 *
 *   • "Add to it": fold the draft into that saved highlight (its text becomes
 *     saved + draft, as separate paragraphs) instead of creating a new one.
 *   • "Not the same": hide that match for the rest of this draft.
 *
 * Silent on every failure path — offline, model not downloadable, API error —
 * because this is a hint, never a gate on saving.
 */
export default function SimilarDraftWarning({
  text,
  html,
  onFolded,
  className = '',
}: {
  text: string
  html: string
  onFolded: (result: FoldedResult) => void
  className?: string
}) {
  const [matches, setMatches] = useState<SimilarSavedHighlight[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [foldingId, setFoldingId] = useState<string | null>(null)
  const [foldError, setFoldError] = useState<string | null>(null)
  const generation = useRef(0)
  const supabase = createClient()

  const plain = embeddingInput(html || text)

  useEffect(() => {
    preloadEmbedder()
  }, [])

  useEffect(() => {
    const gen = ++generation.current
    if (plain.length < MIN_CHARS) {
      setMatches([])
      // A cleared form is a new draft: forget what was dismissed.
      if (plain.length === 0) setDismissed(new Set())
      return
    }
    if (isEffectivelyOffline()) return

    const timer = window.setTimeout(async () => {
      try {
        const embedding = await embedText(plain)
        if (gen !== generation.current) return
        const res = await fetch('/api/highlights/similar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embedding }),
        })
        if (!res.ok) return
        const data = await res.json()
        if (gen !== generation.current) return
        setMatches(data.similar || [])
      } catch {
        // Model unavailable or network hiccup: stay quiet.
      }
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [plain])

  const visible = matches.filter((m) => !dismissed.has(m.id))
  if (visible.length === 0) return null

  const fold = async (m: SimilarSavedHighlight) => {
    if (foldingId) return
    setFoldingId(m.id)
    setFoldError(null)
    const combined = combineHighlights(m, { text, html_content: html })
    try {
      const { error } = await (supabase.from('highlights') as any)
        .update({ text: combined.text, html_content: combined.html })
        .eq('id', m.id)
      if (error) throw error
      // Queue row was written by the DB trigger; refresh the sync badge.
      addToNotionSyncQueue({ highlightId: m.id, operationType: 'update' }).catch(() => {})
      generation.current++
      setMatches([])
      onFolded({ id: m.id, text: combined.text, html: combined.html })
    } catch (e: any) {
      console.error('Failed to fold draft into existing highlight:', e)
      setFoldError(
        e?.code === '23505'
          ? 'That would make it identical to another highlight — nothing was changed.'
          : 'Couldn’t update that highlight. Please try again.'
      )
    } finally {
      setFoldingId(null)
    }
  }

  const strongest = visible[0].similarity

  return (
    <div
      role="status"
      className={`rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/15 px-4 py-3 text-sm ${className}`}
    >
      <div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="font-medium">
          {strongest >= DUPLICATE_SIMILARITY
            ? 'You already have a highlight that says this'
            : 'Similar to something you already saved'}
        </p>
      </div>

      <ul className="mt-2 space-y-1.5">
        {visible.map((m) => {
          const snippet = m.text.replace(/\s+/g, ' ').trim()
          const busy = foldingId === m.id
          return (
            <li
              key={m.id}
              className="flex items-start gap-2 rounded-md bg-white/70 dark:bg-gray-900/40 px-3 py-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-gray-800 dark:text-gray-200 leading-snug">
                  {snippet.length > 200 ? `${snippet.slice(0, 200)}…` : snippet}
                </p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {Math.round(m.similarity * 100)}% similar
                  {(m.author || m.source) && (
                    <>
                      {' · '}
                      {m.author}
                      {m.author && m.source && ', '}
                      {m.source}
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => fold(m)}
                  disabled={foldingId !== null}
                  title="Append this draft to that highlight instead of saving a new one"
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-900 dark:text-amber-100 bg-amber-100 dark:bg-amber-800/50 hover:bg-amber-200 dark:hover:bg-amber-700/60 disabled:opacity-50 transition"
                >
                  <CornerDownRight className="w-3.5 h-3.5" />
                  {busy ? 'Adding…' : 'Add to it'}
                </button>
                <button
                  type="button"
                  onClick={() => setDismissed((prev) => new Set(prev).add(m.id))}
                  disabled={foldingId !== null}
                  title="Not the same idea — hide this match"
                  aria-label="Not the same idea"
                  className="rounded-md p-1 text-gray-500 dark:text-gray-400 hover:bg-amber-100 dark:hover:bg-amber-800/50 disabled:opacity-50 transition"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {foldError && (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300">{foldError}</p>
      )}
    </div>
  )
}
