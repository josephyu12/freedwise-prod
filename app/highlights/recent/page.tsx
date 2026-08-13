'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { HighlightEditLog } from '@/types/database'
import { renderHighlightHtml } from '@/lib/renderHighlightHtml'
import { getHighlightBlockDiff } from '@/lib/highlightDiff'

function DiffBlock({
  text,
  variant,
}: {
  text: string
  variant: 'added' | 'removed'
}) {
  const isAdded = variant === 'added'
  return (
    <div
      className={`rounded-md px-3 py-2 border-l-4 ${
        isAdded
          ? 'bg-green-50 dark:bg-green-900/20 border-green-500'
          : 'bg-red-50 dark:bg-red-900/20 border-red-500 opacity-80'
      }`}
    >
      <div
        className={`highlight-content text-sm prose dark:prose-invert max-w-none ${
          isAdded ? '' : 'line-through'
        }`}
        dangerouslySetInnerHTML={{
          __html: renderHighlightHtml(null, text),
        }}
      />
    </div>
  )
}

function HighlightDiff({
  previousHtml,
  previousText,
  currentHtml,
  currentText,
}: {
  previousHtml?: string | null
  previousText?: string | null
  currentHtml?: string | null
  currentText?: string | null
}) {
  const [showFull, setShowFull] = useState(false)
  const diff = getHighlightBlockDiff(
    previousHtml,
    previousText,
    currentHtml,
    currentText
  )

  const hasChanges =
    diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0

  if (!diff.hasPrevious) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          No edit snapshot yet — make another edit to see what changed.
        </p>
        <button
          type="button"
          onClick={() => setShowFull((v) => !v)}
          className="text-sm text-orange-600 dark:text-orange-400 hover:underline"
        >
          {showFull ? 'Hide full highlight' : 'Show full highlight'}
        </button>
        {showFull && (
          <div
            className="highlight-content text-base prose dark:prose-invert max-w-none opacity-80"
            dangerouslySetInnerHTML={{
              __html: renderHighlightHtml(currentHtml, currentText),
            }}
          />
        )}
      </div>
    )
  }

  if (!hasChanges) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          Edit detected, but no paragraph-level changes found (formatting-only change).
        </p>
        <button
          type="button"
          onClick={() => setShowFull((v) => !v)}
          className="text-sm text-orange-600 dark:text-orange-400 hover:underline"
        >
          {showFull ? 'Hide full highlight' : 'Show full highlight'}
        </button>
        {showFull && (
          <div
            className="highlight-content text-base prose dark:prose-invert max-w-none opacity-80"
            dangerouslySetInnerHTML={{
              __html: renderHighlightHtml(currentHtml, currentText),
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {diff.modified.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Modified ({diff.modified.length})
          </p>
          {diff.modified.map((item, i) => (
            <div
              key={`modified-${i}`}
              className="rounded-md px-3 py-2 border-l-4 bg-amber-50 dark:bg-amber-900/20 border-amber-500"
            >
              <div
                className="highlight-content text-sm prose dark:prose-invert max-w-none"
                dangerouslySetInnerHTML={{ __html: item.diffHtml }}
              />
            </div>
          ))}
        </div>
      )}
      {diff.added.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
            Added ({diff.added.length})
          </p>
          {diff.added.map((text, i) => (
            <DiffBlock key={`added-${i}`} text={text} variant="added" />
          ))}
        </div>
      )}
      {diff.removed.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
            Removed ({diff.removed.length})
          </p>
          {diff.removed.map((text, i) => (
            <DiffBlock key={`removed-${i}`} text={text} variant="removed" />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setShowFull((v) => !v)}
        className="text-sm text-orange-600 dark:text-orange-400 hover:underline"
      >
        {showFull ? 'Hide full highlight' : 'Show full highlight'}
      </button>
      {showFull && (
        <div
          className="highlight-content text-base prose dark:prose-invert max-w-none opacity-80 border-t border-gray-200 dark:border-gray-700 pt-3"
          dangerouslySetInnerHTML={{
            __html: renderHighlightHtml(currentHtml, currentText),
          }}
        />
      )}
    </div>
  )
}

export default function RecentHighlightsPage() {
  const [editLogs, setEditLogs] = useState<HighlightEditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage] = useState(20)
  const [totalEdits, setTotalEdits] = useState(0)
  const supabase = createClient()

  useEffect(() => {
    loadEditLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage])

  const loadEditLogs = async () => {
    try {
      setLoading(true)

      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        setLoading(false)
        return
      }

      const { count, error: countError } = await supabase
        .from('highlight_edit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)

      if (countError) throw countError
      setTotalEdits(count || 0)

      const from = (currentPage - 1) * itemsPerPage
      const to = from + itemsPerPage - 1

      const { data, error } = await supabase
        .from('highlight_edit_logs')
        .select(`
          *,
          highlight:highlights (
            *,
            highlight_categories (
              category:categories (*)
            )
          )
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(from, to)

      if (error) throw error

      const processedLogs = (data || []).map((log: any) => ({
        ...log,
        highlight: log.highlight
          ? {
              ...log.highlight,
              categories: log.highlight.highlight_categories?.map((hc: any) => hc.category) || [],
            }
          : undefined,
      }))

      setEditLogs(processedLogs)
    } catch (error) {
      console.error('Error loading recently edited highlights:', error)
    } finally {
      setLoading(false)
    }
  }

  const totalPages = Math.ceil(totalEdits / itemsPerPage)

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white mb-2">
              Recently Edited
            </h1>
            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300">
              Every text edit is logged, including multiple edits to the same highlight.
              Logs older than 90 days are removed.
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
                Edit log ({totalEdits})
              </h2>
              <Link
                href="/highlights"
                className="text-sm text-orange-600 dark:text-orange-400 hover:underline"
              >
                Go to all highlights →
              </Link>
            </div>

            {editLogs.length === 0 ? (
              <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-lg text-center">
                <p className="text-gray-500 dark:text-gray-400 mb-4">
                  No edited highlights yet. When you update a highlight&apos;s text, it will appear here.
                </p>
                <Link
                  href="/highlights"
                  className="inline-block px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition"
                >
                  Go to Highlights
                </Link>
              </div>
            ) : (
              editLogs.map((log) => {
                const highlight = log.highlight
                return (
                <div
                  key={log.id}
                  className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg border border-orange-200 dark:border-orange-800/50"
                >
                  <HighlightDiff
                    previousHtml={log.previous_html_content}
                    previousText={log.previous_text}
                    currentHtml={log.new_html_content}
                    currentText={log.new_text}
                  />
                  {highlight?.categories && highlight.categories.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-4 mb-3">
                      {highlight.categories.map((cat) => (
                        <span
                          key={cat.id}
                          className="px-2 py-1 text-xs rounded-full bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200"
                        >
                          {cat.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {(highlight?.source || highlight?.author) && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                      {highlight.author && <span>{highlight.author}</span>}
                      {highlight.author && highlight.source && <span> • </span>}
                      {highlight.source && <span>{highlight.source}</span>}
                    </p>
                  )}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                      <span className="font-medium text-orange-600 dark:text-orange-400">
                        Edited {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                      </span>
                      {highlight?.created_at && (
                        <span>
                          Created {new Date(highlight.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </span>
                      )}
                    </div>
                    {highlight?.id && (
                      <Link
                        href={`/highlights#highlight-${highlight.id}`}
                        className="inline-flex items-center justify-center px-3 py-1.5 text-sm bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 rounded hover:bg-orange-200 dark:hover:bg-orange-800/60 transition"
                      >
                        Open in Highlights
                      </Link>
                    )}
                  </div>
                </div>
                )
              })
            )}

            {totalPages > 1 && (
              <div className="flex flex-col sm:flex-row justify-between items-center gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, totalEdits)} of {totalEdits} edits
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <span className="px-4 py-2 text-gray-600 dark:text-gray-400">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
