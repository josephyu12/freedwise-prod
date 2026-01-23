'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Highlight } from '@/types/database'
import Link from 'next/link'

export default function ArchivesPage() {
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(20)
  const [totalHighlights, setTotalHighlights] = useState(0)
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

  // Helper function to add item to Notion sync queue
  const addToSyncQueue = async (
    highlightId: string,
    operationType: 'add' | 'update' | 'delete',
    text?: string | null,
    htmlContent?: string | null,
    originalText?: string | null,
    originalHtmlContent?: string | null
  ) => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: notionSettings, error: settingsError } = await supabase
        .from('user_notion_settings')
        .select('notion_api_key, notion_page_id, enabled')
        .eq('user_id', user.id)
        .eq('enabled', true)
        .maybeSingle()

      if (settingsError || !notionSettings) {
        return
      }

      // For delete operations, we can set highlight_id to null since the highlight will be deleted
      // and we only need the text/html to find it in Notion
      const queueItem: any = {
        user_id: user.id,
        highlight_id: operationType === 'delete' ? null : highlightId, // Null for delete since highlight will be deleted
        operation_type: operationType,
        text: text || null,
        html_content: htmlContent || null,
        status: 'pending',
        retry_count: 0,
        max_retries: 5,
      }

      if (operationType === 'update' && (originalText || originalHtmlContent)) {
        queueItem.original_text = originalText || null
        queueItem.original_html_content = originalHtmlContent || null
      }

      const { error: queueError } = await (supabase
        .from('notion_sync_queue') as any)
        .insert([queueItem])

      if (queueError) {
        console.warn('Failed to add to sync queue:', queueError)
      }
    } catch (error) {
      console.warn('Error adding to sync queue:', error)
    }
  }

  const handleUnarchive = async (id: string) => {
    try {
      // Update in database (no Notion sync - archive status not supported by Notion)
      await (supabase
        .from('highlights') as any)
        .update({ archived: false })
        .eq('id', id)

      await loadHighlights()
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

      // Add to Notion sync queue BEFORE deleting (if configured)
      await addToSyncQueue(
        id,
        'delete',
        text,
        htmlContent
      )

      // Delete from database
      const { error } = await (supabase
        .from('highlights') as any)
        .delete()
        .eq('id', id)

      if (error) throw error

      await loadHighlights()
    } catch (error) {
      console.error('Error deleting highlight:', error)
      alert('Failed to delete highlight. Please try again.')
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
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white">
              Archived Highlights
            </h1>
            <div className="flex gap-2">
              <Link
                href="/highlights"
                className="flex items-center gap-2 px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition text-sm sm:text-base"
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                <span>Back</span>
              </Link>
              <Link
                href="/"
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
              >
                Home
              </Link>
            </div>
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
                  className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg opacity-60 border-2 border-orange-300 dark:border-orange-700"
                >
                  <div
                    className="highlight-content text-base mb-3 prose dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{
                      __html: highlight.html_content || highlight.text,
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
                  <div className="flex gap-2 mt-3">
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
    </main>
  )
}

