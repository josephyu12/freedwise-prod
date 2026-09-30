'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Merge, RefreshCw, Check, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { renderHighlightHtml } from '@/lib/renderHighlightHtml'
import RichTextEditor from '@/components/RichTextEditor'
import ActionToast, { useActionToast } from '@/components/ActionToast'
import { useEmbeddingSync } from '@/hooks/useEmbeddingSync'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import { callRedistribute } from '@/lib/redistribute'
import { canonicalPair } from '@/lib/highlightLinks'
import { combineHighlights, toEditorHtml } from '@/lib/combineHighlights'
import type { MergeCandidate, MergeSuggestion } from '@/app/api/highlights/merge-suggestions/route'

// Cosine floors the user can pick between. The API always returns >= 0.85;
// the choice here is a client-side filter so switching is instant.
const THRESHOLDS = [
  { value: 0.95, label: 'Near-identical', hint: '95%+' },
  { value: 0.9, label: 'Very similar', hint: '90%+' },
  { value: 0.85, label: 'Similar', hint: '85%+' },
] as const
type Threshold = (typeof THRESHOLDS)[number]['value']
const THRESHOLD_KEY = 'freedwise:merge-threshold'

type LoadError = { kind: 'migration' | 'generic'; message: string }

type MergeDraft = {
  key: string
  keepId: string
  text: string
  html: string
}

function pairKey(s: MergeSuggestion) {
  return `${s.a.id}|${s.b.id}`
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatRating(h: MergeCandidate) {
  if (!h.rating_count || h.average_rating <= 0) return 'Not rated yet'
  return `${h.average_rating.toFixed(1)}/3 · ${h.rating_count} rating${h.rating_count === 1 ? '' : 's'}`
}

export default function MergePage() {
  const supabase = createClient()
  const { toast, showToast } = useActionToast()
  // Re-embed anything edited since the last visit so new near-copies show up.
  const embeddingSync = useEmbeddingSync()

  const [suggestions, setSuggestions] = useState<MergeSuggestion[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadError | null>(null)
  const [threshold, setThreshold] = useState<Threshold>(0.9)
  const [draft, setDraft] = useState<MergeDraft | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(THRESHOLD_KEY))
      if (THRESHOLDS.some((t) => t.value === stored)) setThreshold(stored as Threshold)
    } catch {
      /* default */
    }
  }, [])

  const pickThreshold = (value: Threshold) => {
    setThreshold(value)
    try {
      window.localStorage.setItem(THRESHOLD_KEY, String(value))
    } catch {
      /* ignore */
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/highlights/merge-suggestions')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data?.error === 'migration_required') {
          setError({ kind: 'migration', message: data.message })
        } else {
          setError({ kind: 'generic', message: data?.error || `Request failed (${res.status})` })
        }
        setSuggestions(null)
        return
      }
      setSuggestions(data.suggestions || [])
    } catch (e: any) {
      setError({ kind: 'generic', message: e?.message || 'Could not load suggestions' })
      setSuggestions(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const visible = useMemo(
    () => (suggestions || []).filter((s) => s.similarity >= threshold),
    [suggestions, threshold]
  )
  const countAt = (t: Threshold) => (suggestions || []).filter((s) => s.similarity >= t).length

  const flashNotice = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(null), 5000)
  }

  // ─── Keep both ─────────────────────────────────────────────
  const handleDismiss = async (s: MergeSuggestion) => {
    const key = pairKey(s)
    if (busyKey) return
    setBusyKey(key)
    const snapshot = suggestions
    setSuggestions((prev) => (prev ? prev.filter((x) => pairKey(x) !== key) : prev))
    if (draft?.key === key) setDraft(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not signed in')
      const [a, b] = canonicalPair(s.a.id, s.b.id)
      const { error: insertError } = await (supabase.from('highlight_merge_dismissals') as any).upsert(
        { user_id: user.id, highlight_a: a, highlight_b: b },
        { onConflict: 'user_id,highlight_a,highlight_b', ignoreDuplicates: true }
      )
      if (insertError) throw insertError
      showToast('Kept both — this pair won’t be suggested again')
    } catch (e) {
      console.error('Failed to dismiss merge suggestion:', e)
      setSuggestions(snapshot)
      alert('Could not save that. Please try again.')
    } finally {
      setBusyKey(null)
    }
  }

  // ─── Merge ─────────────────────────────────────────────────
  const startMerge = (s: MergeSuggestion) => {
    // Default to keeping the older highlight: it carries the longer review
    // history (months reviewed, ratings), which the merge preserves.
    const keep = s.a.created_at <= s.b.created_at ? s.a : s.b
    const other = keep === s.a ? s.b : s.a
    const { html, text } = combineHighlights(keep, other)
    setDraft({ key: pairKey(s), keepId: keep.id, text, html })
  }

  const setKeep = (s: MergeSuggestion, keepId: string) => {
    if (!draft || draft.key !== pairKey(s) || draft.keepId === keepId) return
    // Changing which highlight survives doesn't change the words the user is
    // merging — only the row the words are written to.
    setDraft({ ...draft, keepId })
  }

  const resetDraftTo = (s: MergeSuggestion, mode: 'both' | 'keep-only') => {
    if (!draft || draft.key !== pairKey(s)) return
    const keep = s.a.id === draft.keepId ? s.a : s.b
    const other = keep === s.a ? s.b : s.a
    if (mode === 'both') {
      const { html, text } = combineHighlights(keep, other)
      setDraft({ ...draft, html, text })
    } else {
      setDraft({ ...draft, html: toEditorHtml(keep), text: keep.text })
    }
  }

  const handleConfirmMerge = async (s: MergeSuggestion) => {
    if (!draft || draft.key !== pairKey(s) || busyKey) return
    const text = draft.text.trim()
    if (!text) {
      alert('The merged highlight can’t be empty.')
      return
    }
    const keep = s.a.id === draft.keepId ? s.a : s.b
    const remove = keep === s.a ? s.b : s.a
    const html = draft.html.trim() || null
    const key = draft.key

    setBusyKey(key)
    try {
      const { error: rpcError } = await (supabase as any).rpc('merge_highlights', {
        p_keep: keep.id,
        p_remove: remove.id,
        p_text: text,
        p_html: html,
      })
      if (rpcError) throw rpcError

      // Drop every pair that involved the removed highlight, and show the new
      // wording on any remaining pair that involves the kept one.
      setSuggestions((prev) =>
        prev
          ? prev
              .filter((x) => x.a.id !== remove.id && x.b.id !== remove.id)
              .map((x) => {
                if (x.a.id !== keep.id && x.b.id !== keep.id) return x
                const patched = { ...keep, text, html_content: html }
                return x.a.id === keep.id ? { ...x, a: patched } : { ...x, b: patched }
              })
          : prev
      )
      setDraft(null)
      showToast('Merged into one highlight')

      // Notion queue rows were written by the DB trigger; nudge the badge.
      addToNotionSyncQueue({ highlightId: keep.id, operationType: 'update' }).catch(() => {})
      // The removed highlight's future review slots are gone; rebalance.
      callRedistribute().catch(() => {})
    } catch (e: any) {
      console.error('Merge failed:', e)
      if (e?.code === '23505') {
        flashNotice('That merged text is identical to another highlight — nothing was changed.')
      } else if (e?.code === 'PGRST202' || e?.code === '42883') {
        setError({
          kind: 'migration',
          message:
            'Run supabase/migration_merge_suggestions.sql in the Supabase SQL editor to enable merging.',
        })
      } else {
        alert(e?.message || 'Merge failed. Please try again.')
      }
    } finally {
      setBusyKey(null)
    }
  }

  // ─── Render ────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-5xl mx-auto">
          <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white mb-2">
                Similar highlights
              </h1>
              <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300">
                Pairs that say nearly the same thing. Merge the two into one idea, or keep both.
              </p>
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="self-start inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-sm font-medium bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Rescan
            </button>
          </div>

          {embeddingSync.syncing && (
            <div className="mb-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 px-4 py-2.5 text-sm text-blue-800 dark:text-blue-200">
              Indexing {embeddingSync.remaining ?? embeddingSync.total} recently edited highlight
              {(embeddingSync.remaining ?? embeddingSync.total) === 1 ? '' : 's'}… rescan when done
              to include them.
            </div>
          )}

          {notice && (
            <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-200">
              {notice}
            </div>
          )}

          {/* Threshold picker */}
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 mr-1">
              Show pairs
            </span>
            {THRESHOLDS.map((t) => {
              const active = threshold === t.value
              return (
                <button
                  key={t.value}
                  onClick={() => pickThreshold(t.value)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition border ${
                    active
                      ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
                      : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {t.label}
                  <span className={`text-xs ${active ? 'text-blue-100' : 'text-gray-400 dark:text-gray-500'}`}>
                    {t.hint}
                    {suggestions ? ` · ${countAt(t.value)}` : ''}
                  </span>
                </button>
              )
            })}
          </div>

          {loading ? (
            <div className="bg-white dark:bg-gray-800 p-8 sm:p-12 rounded-lg shadow-lg text-center">
              <div className="text-lg text-gray-600 dark:text-gray-400">
                Comparing every highlight against every other…
              </div>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-500">
                This takes a moment on a large library.
              </p>
            </div>
          ) : error ? (
            <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-lg border border-amber-300 dark:border-amber-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                {error.kind === 'migration' ? 'One-time setup needed' : 'Couldn’t load suggestions'}
              </h2>
              <p className="text-sm text-gray-700 dark:text-gray-300">{error.message}</p>
              {error.kind === 'migration' && (
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  The file lives in the repo under <code className="font-mono">supabase/</code>. It is
                  idempotent — safe to run more than once.
                </p>
              )}
            </div>
          ) : visible.length === 0 ? (
            <div className="bg-white dark:bg-gray-800 p-8 sm:p-12 rounded-lg shadow-lg text-center">
              <Merge className="w-16 h-16 text-gray-400 dark:text-gray-600 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
                {suggestions && suggestions.length > 0
                  ? 'Nothing this close'
                  : 'No near-duplicates found'}
              </h2>
              <p className="text-gray-600 dark:text-gray-300 mb-4">
                {suggestions && suggestions.length > 0
                  ? 'Try a looser threshold above to see pairs that share an idea but not the wording.'
                  : 'Every highlight says something the others don’t. Come back after a big writing session.'}
              </p>
              <Link
                href="/highlights"
                className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Go to Highlights
              </Link>
            </div>
          ) : (
            <div className="space-y-5">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {visible.length} pair{visible.length === 1 ? '' : 's'}, strongest first.
              </p>
              {visible.map((s) => {
                const key = pairKey(s)
                const isDrafting = draft?.key === key
                const busy = busyKey === key
                const keep = isDrafting ? (draft!.keepId === s.a.id ? s.a : s.b) : null
                return (
                  <section
                    key={key}
                    className={`bg-white dark:bg-gray-800 rounded-lg shadow-lg border ${
                      isDrafting
                        ? 'border-blue-400 dark:border-blue-600 ring-1 ring-blue-300 dark:ring-blue-700'
                        : 'border-gray-200 dark:border-gray-700'
                    } ${busy ? 'opacity-60 pointer-events-none' : ''}`}
                  >
                    {/* Pair header */}
                    <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
                      <div className="flex items-center gap-2 text-sm">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                            s.similarity >= 0.95
                              ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200'
                              : s.similarity >= 0.9
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
                          }`}
                        >
                          {Math.round(s.similarity * 100)}% same meaning
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {Math.round(s.wordOverlap * 100)}% same words
                        </span>
                      </div>
                      {!isDrafting && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleDismiss(s)}
                            disabled={busyKey !== null}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition"
                            title="These are different ideas — stop suggesting this pair"
                          >
                            <X className="w-4 h-4" /> Keep both
                          </button>
                          <button
                            onClick={() => startMerge(s)}
                            disabled={busyKey !== null}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition"
                          >
                            <Merge className="w-4 h-4" /> Merge…
                          </button>
                        </div>
                      )}
                    </div>

                    {/* The two highlights */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
                      {[s.a, s.b].map((h) => {
                        const isKeep = isDrafting && keep?.id === h.id
                        return (
                          <div
                            key={h.id}
                            className={`rounded-lg border p-4 ${
                              isDrafting
                                ? isKeep
                                  ? 'border-green-400 dark:border-green-600 bg-green-50/60 dark:bg-green-900/20'
                                  : 'border-gray-200 dark:border-gray-700 opacity-75'
                                : 'border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/60'
                            }`}
                          >
                            {isDrafting && (
                              <label className="flex items-center gap-2 mb-3 text-sm font-medium text-gray-800 dark:text-gray-200 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`keep-${key}`}
                                  checked={isKeep}
                                  onChange={() => setKeep(s, h.id)}
                                  className="accent-green-600"
                                />
                                {isKeep ? 'Keep this one' : 'Keep this one instead'}
                                <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                                  {isKeep ? '· keeps its review history, ratings & pin' : ''}
                                </span>
                              </label>
                            )}
                            <div
                              className="highlight-content text-sm sm:text-base prose dark:prose-invert max-w-none"
                              dangerouslySetInnerHTML={{
                                __html: renderHighlightHtml(h.html_content, h.text),
                              }}
                            />
                            {h.categories.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mt-3">
                                {h.categories.map((c) => (
                                  <span
                                    key={c.id}
                                    className="px-2 py-0.5 text-xs rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200"
                                  >
                                    {c.name}
                                  </span>
                                ))}
                              </div>
                            )}
                            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                              Added {formatDate(h.created_at)} · {formatRating(h)}
                              {h.resurface_count > 0 &&
                                ` · reviewed ${h.resurface_count}×`}
                              {(h.author || h.source) && (
                                <>
                                  {' · '}
                                  {h.author}
                                  {h.author && h.source && ', '}
                                  {h.source}
                                </>
                              )}
                            </p>
                          </div>
                        )
                      })}
                    </div>

                    {/* Merge editor */}
                    {isDrafting && (
                      <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                            Write the merged highlight
                          </p>
                          <div className="flex items-center gap-1 text-xs">
                            <span className="text-gray-500 dark:text-gray-400 mr-1">Start from:</span>
                            <button
                              onClick={() => resetDraftTo(s, 'both')}
                              className="px-2 py-1 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                            >
                              both texts
                            </button>
                            <button
                              onClick={() => resetDraftTo(s, 'keep-only')}
                              className="px-2 py-1 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                            >
                              kept text only
                            </button>
                          </div>
                        </div>
                        <RichTextEditor
                          value={draft!.text}
                          htmlValue={draft!.html}
                          onChange={(text, html) =>
                            setDraft((prev) => (prev && prev.key === key ? { ...prev, text, html } : prev))
                          }
                          placeholder="Combine the two into one idea…"
                        />
                        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          The other highlight is deleted. Its categories, links and pin move to the one you keep.
                          This can’t be undone.
                        </p>
                        <div className="mt-3 flex items-center justify-end gap-2">
                          <button
                            onClick={() => setDraft(null)}
                            className="px-3.5 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleConfirmMerge(s)}
                            disabled={busy || !draft!.text.trim()}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition"
                          >
                            <Check className="w-4 h-4" /> Merge & delete other
                          </button>
                        </div>
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <ActionToast toast={toast} />
    </main>
  )
}
