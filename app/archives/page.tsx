'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Highlight } from '@/types/database'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import { renderHighlightHtml } from '@/lib/renderHighlightHtml'
import ActionToast, { useActionToast } from '@/components/ActionToast'
import SelectModeBar, { SelectCheck, archiveActionError } from '@/components/SelectModeBar'

export default function ArchivesPage() {
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(20)
  const [totalHighlights, setTotalHighlights] = useState(0)
  const [selectMode, setSelectMode] = useState(false)
  // Selection intentionally survives pagination — bulk actions apply to every
  // selected id, even ones picked on other pages.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkWorking, setBulkWorking] = useState(false)
  const { toast, showToast } = useActionToast()
  const supabase = createClient()

  useEffect(() => {
    loadHighlights()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, itemsPerPage])

  const loadHighlights = async () => {
    try {
      setLoading(true)
      
      // Get authenticated user for filtering
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        setLoading(false)
        return
      }
      
      // Get the total count (explicitly filter by user_id for accuracy)
      const { count, error: countError } = await supabase
        .from('highlights')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('archived', true)

      if (countError) throw countError
      setTotalHighlights(count || 0)

      // Get the paginated data (explicitly filter by user_id for accuracy)
      const from = (currentPage - 1) * itemsPerPage
      const to = from + itemsPerPage - 1

      const { data, error } = await supabase
        .from('highlights')
        .select(`
          *,
          highlight_categories (
            category:categories (*)
          )
        `)
        .eq('user_id', user.id)
        .eq('archived', true)
        .order('created_at', { ascending: false })
        .range(from, to)

      if (error) throw error

      const processedHighlights = (data || []).map((h: any) => ({
        ...h,
        categories: h.highlight_categories?.map((hc: any) => hc.category) || [],
      }))

      setHighlights(processedHighlights)
    } catch (error) {
      console.error('Error loading archived highlights:', error)
    } finally {
      setLoading(false)
    }
  }

  const totalPages = Math.ceil(totalHighlights / itemsPerPage)

  // Add item to Notion sync queue via deduplicating API
  const addToSyncQueue = async (
    highlightId: string,
    operationType: 'add' | 'update' | 'delete',
    text?: string | null,
    htmlContent?: string | null,
    originalText?: string | null,
    originalHtmlContent?: string | null
  ) => {
    await addToNotionSyncQueue({
      highlightId,
      operationType,
      text: text ?? null,
      htmlContent: htmlContent ?? null,
      originalText: originalText ?? null,
      originalHtmlContent: originalHtmlContent ?? null,
    })
  }

  const handleUnarchive = async (id: string) => {
    try {
      // Update in database (no Notion sync - archive status not supported by Notion)
      const { error } = await (supabase
        .from('highlights') as any)
        .update({ archived: false, unarchived_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error

      await loadHighlights()
      showToast('Highlight unarchived')
    } catch (error) {
      console.error('Error unarchiving highlight:', error)
      alert('Failed to unarchive highlight. Please try again.')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this highlight?')) return

    try {
      const highlight = highlights.find((h) => h.id === id)
      if (!highlight) return

      const text = highlight.text || null
      const htmlContent = highlight.html_content || null

      // Delete from database first (CASCADE removes it from daily_summary_highlights, so it won't appear in next month's daily reviews).
      // Only enqueue the Notion delete after the DB delete succeeds — otherwise we can
      // wipe the highlight from Notion while it's still in Supabase.
      const { error } = await (supabase
        .from('highlights') as any)
        .delete()
        .eq('id', id)

      if (error) throw error

      await addToSyncQueue(
        id,
        'delete',
        text,
        htmlContent
      )

      // Redistribute remaining highlights across future days so next month's daily reviews stay consistent
      await fetch('/api/daily/redistribute', { method: 'POST' })

      await loadHighlights()
      showToast('Highlight deleted')
    } catch (error) {
      console.error('Error deleting highlight:', error)
      alert('Failed to delete highlight. Please try again.')
    }
  }

  // ─── Select mode / bulk actions ────────────────────────────

  const toggleSelectMode = () => {
    if (selectMode) {
      setSelectMode(false)
      setSelectedIds(new Set())
    } else {
      setSelectMode(true)
    }
  }

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const allOnPageSelected =
    highlights.length > 0 && highlights.every((h) => selectedIds.has(h.id))

  const toggleSelectPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) {
        highlights.forEach((h) => next.delete(h.id))
      } else {
        highlights.forEach((h) => next.add(h.id))
      }
      return next
    })
  }

  const handleBulkArchive = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || bulkWorking) return
    const mismatch = archiveActionError(
      'archive',
      ids.map((id) => highlights.find((h) => h.id === id) ?? { archived: true })
    )
    if (mismatch) {
      alert(mismatch)
      return
    }
  }

  const handleBulkUnarchive = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || bulkWorking) return
    const mismatch = archiveActionError(
      'unarchive',
      ids.map((id) => highlights.find((h) => h.id === id) ?? { archived: true })
    )
    if (mismatch) {
      alert(mismatch)
      return
    }
    if (!confirm(`Are you sure you want to unarchive ${ids.length} highlight${ids.length === 1 ? '' : 's'}?`)) return

    setBulkWorking(true)
    try {
      const { error } = await (supabase
        .from('highlights') as any)
        .update({ archived: false, unarchived_at: new Date().toISOString() })
        .in('id', ids)
      if (error) throw error

      setSelectedIds(new Set())
      setSelectMode(false)
      await loadHighlights()
      showToast(`${ids.length} highlight${ids.length === 1 ? '' : 's'} unarchived`)
    } catch (error) {
      console.error('Error bulk unarchiving highlights:', error)
      alert('Failed to unarchive highlights. Please try again.')
    } finally {
      setBulkWorking(false)
    }
  }

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || bulkWorking) return
    if (!confirm(`Are you sure you want to delete ${ids.length} highlight${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return

    setBulkWorking(true)
    try {
      // Capture text for the Notion sync queue before rows leave state.
      const byId = new Map(highlights.map((h) => [h.id, h]))

      const { error } = await (supabase
        .from('highlights') as any)
        .delete()
        .in('id', ids)
      if (error) throw error

      for (const id of ids) {
        const h = byId.get(id)
        await addToSyncQueue(id, 'delete', h?.text ?? null, h?.html_content ?? null).catch((err) =>
          console.error('Error queueing Notion delete:', err)
        )
      }
      // One redistribute for the whole batch keeps future daily reviews consistent.
      await fetch('/api/daily/redistribute', { method: 'POST' }).catch(() => {})

      setSelectedIds(new Set())
      setSelectMode(false)
      await loadHighlights()
      showToast(`${ids.length} highlight${ids.length === 1 ? '' : 's'} deleted`)
    } catch (error) {
      console.error('Error bulk deleting highlights:', error)
      alert('Failed to delete highlights. Please try again.')
    } finally {
      setBulkWorking(false)
    }
  }

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
          <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white">
              Archived Highlights
            </h1>
            {(totalHighlights > 0 || selectMode) && (
              <button
                onClick={toggleSelectMode}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-full transition-all text-sm font-medium ${
                  selectMode
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{selectMode ? 'Done' : 'Select'}</span>
              </button>
            )}
          </div>

          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
                All Archived Highlights ({totalHighlights})
              </h2>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600 dark:text-gray-400">
                  Show:
                </label>
                <select
                  value={itemsPerPage}
                  onChange={(e) => {
                    setItemsPerPage(Number(e.target.value))
                    setCurrentPage(1)
                  }}
                  className="px-3 py-1 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                >
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  per page
                </span>
              </div>
            </div>
            {highlights.length === 0 ? (
              <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-lg text-center text-gray-500 dark:text-gray-400">
                No archived highlights yet.
              </div>
            ) : (
              highlights.map((highlight) => (
                <div
                  key={highlight.id}
                  onClick={selectMode ? () => toggleSelected(highlight.id) : undefined}
                  className={`relative bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg opacity-60 border-2 border-orange-300 dark:border-orange-700 ${
                    selectMode ? 'cursor-pointer select-none' : ''
                  } ${selectMode && selectedIds.has(highlight.id) ? 'ring-2 ring-blue-500' : ''}`}
                >
                  {selectMode && <SelectCheck selected={selectedIds.has(highlight.id)} />}
                  <div
                    className="highlight-content text-base mb-3 prose dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{
                      __html: renderHighlightHtml(highlight.html_content, highlight.text),
                    }}
                  />
                  {highlight.categories && highlight.categories.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                      {highlight.categories.map((cat: any) => (
                        <span
                          key={cat.id}
                          className="px-2 py-1 text-xs rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200"
                        >
                          {cat.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {(highlight.source || highlight.author) && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                      {highlight.author && <span>{highlight.author}</span>}
                      {highlight.author && highlight.source && <span> • </span>}
                      {highlight.source && <span>{highlight.source}</span>}
                    </p>
                  )}
                  {!selectMode && (
                    <div className="flex flex-col sm:flex-row gap-2 mt-3">
                      <button
                        onClick={() => handleUnarchive(highlight.id)}
                        className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                      >
                        Unarchive
                      </button>
                      <button
                        onClick={() => handleDelete(highlight.id)}
                        className="px-3 py-1 text-sm bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-800 transition"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex flex-col sm:flex-row justify-between items-center gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, totalHighlights)} of {totalHighlights} highlights
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
      {selectMode && (
        <SelectModeBar
          selectedCount={selectedIds.size}
          allOnPageSelected={allOnPageSelected}
          bulkWorking={bulkWorking}
          onTogglePage={toggleSelectPage}
          onArchive={handleBulkArchive}
          onUnarchive={handleBulkUnarchive}
          onDelete={handleBulkDelete}
          onCancel={toggleSelectMode}
        />
      )}
      <ActionToast toast={toast} />
    </main>
  )
}

