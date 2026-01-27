'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Highlight, Category } from '@/types/database'
import Link from 'next/link'
import { useDebounce } from '@/hooks/useDebounce'
import RichTextEditor from '@/components/RichTextEditor'
import PinDialog from '@/components/PinDialog'
import { Pin, PinOff } from 'lucide-react'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const [searchType, setSearchType] = useState<'fulltext' | 'semantic'>('fulltext')
  const [results, setResults] = useState<Highlight[]>([])
  const [similarResults, setSimilarResults] = useState<Highlight[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedHighlight, setSelectedHighlight] = useState<Highlight | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editHtmlContent, setEditHtmlContent] = useState('')
  const [editSource, setEditSource] = useState('')
  const [editAuthor, setEditAuthor] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [editCategories, setEditCategories] = useState<string[]>([])
  const [skipNotionSync, setSkipNotionSync] = useState(false)
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)
  const supabase = createClient()

  const debouncedQuery = useDebounce(query, 500)

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
      highlightId: operationType === 'delete' ? null : highlightId,
      operationType,
      text: text ?? null,
      htmlContent: htmlContent ?? null,
      originalText: originalText ?? null,
      originalHtmlContent: originalHtmlContent ?? null,
    })
  }

  // Load categories on mount
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const { data: categoriesData, error } = await supabase
          .from('categories')
          .select('*')
          .order('name')

        if (error) throw error
        setCategories((categoriesData || []) as any[])
      } catch (error) {
        console.error('Error loading categories:', error)
      }
    }
    loadCategories()
  }, [supabase])

  // Load pinned highlights
  useEffect(() => {
    const loadPinnedHighlights = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return

        const { data, error } = await (supabase
          .from('pinned_highlights') as any)
          .select('highlight_id')
          .eq('user_id', user.id)

        if (error) throw error
        setPinnedHighlightIds(new Set((data || []).map((p: any) => p.highlight_id)))
      } catch (error) {
        console.error('Error loading pinned highlights:', error)
      }
    }
    loadPinnedHighlights()
  }, [supabase])

  const performSearch = useCallback(async (searchQuery: string, type: 'fulltext' | 'semantic') => {
    if (!searchQuery.trim()) {
      setResults([])
      setSimilarResults([])
      setSelectedHighlight(null)
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: searchQuery.trim(),
          type,
        }),
      })

      if (!response.ok) {
        throw new Error('Search failed')
      }

      const data = await response.json()
      setResults(data.results || [])
      setSimilarResults(data.similar || [])
      
      // If we have results, select the first one to show similar highlights
      if (data.results && data.results.length > 0) {
        setSelectedHighlight(data.results[0])
      } else {
        setSelectedHighlight(null)
      }
    } catch (error) {
      console.error('Error performing search:', error)
      setResults([])
      setSimilarResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debouncedQuery) {
      performSearch(debouncedQuery, searchType)
    } else {
      setResults([])
      setSimilarResults([])
      setSelectedHighlight(null)
    }
  }, [debouncedQuery, searchType, performSearch])

  const handleHighlightClick = async (highlight: Highlight) => {
    if (editingId === highlight.id) return // Don't select if editing
    setSelectedHighlight(highlight)
    
    // Fetch similar highlights for the selected one
    if (highlight.id) {
      try {
        const response = await fetch('/api/search/similar', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            highlightId: highlight.id,
            text: highlight.text,
            htmlContent: highlight.html_content,
          }),
        })

        if (response.ok) {
          const data = await response.json()
          setSimilarResults(data.similar || [])
        }
      } catch (error) {
        console.error('Error fetching similar highlights:', error)
      }
    }
  }

  const handleStartEdit = (highlight: Highlight, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation() // Prevent triggering highlight click
    }
    setEditingId(highlight.id)
    setEditText(highlight.text)
    setEditHtmlContent(highlight.html_content || highlight.text)
    setEditSource(highlight.source || '')
    setEditAuthor(highlight.author || '')
    setEditCategories(highlight.categories?.map((c: any) => c.id) || [])
    setSkipNotionSync(false)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditText('')
    setEditHtmlContent('')
    setEditSource('')
    setEditAuthor('')
    setEditCategories([])
    setSkipNotionSync(false)
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editText.trim()) return

    try {
      // Get original highlight data before updating (needed for sync queue)
      const allHighlights = [...results, ...similarResults]
      const originalHighlight = allHighlights.find((h) => h.id === editingId)
      const originalText = originalHighlight?.text || null
      const originalHtmlContent = originalHighlight?.html_content || null

      // Check for duplicate highlights (excluding current one)
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: existingHighlights, error: checkError } = await (supabase
          .from('highlights') as any)
          .select('id, text, html_content')
          .eq('user_id', user.id)
          .neq('id', editingId)

        if (checkError) {
          console.error('Error checking for duplicates:', checkError)
        } else if (existingHighlights && existingHighlights.length > 0) {
          // Helper function to normalize text (strip HTML tags, trim, lowercase, normalize whitespace)
          const normalizeText = (text: string | null): string => {
            if (!text) return ''
            // Strip HTML tags first
            const plainText = text.replace(/<[^>]*>/g, '')
            // Trim, lowercase, and normalize whitespace
            return plainText.trim().toLowerCase().replace(/\s+/g, ' ')
          }
          
          // Normalize the edited text and HTML
          const normalizedEditText = normalizeText(editText)
          const normalizedEditHtml = normalizeText(editHtmlContent)
          
          // Check if any other highlight has the same normalized text or html_content
          const isDuplicate = existingHighlights.some((h: any) => {
            const existingText = normalizeText(h.text)
            const existingHtml = normalizeText(h.html_content)
            // Check if normalized text matches, or if normalized HTML matches
            return (normalizedEditText && (normalizedEditText === existingText || normalizedEditText === existingHtml)) ||
                   (normalizedEditHtml && (normalizedEditHtml === existingText || normalizedEditHtml === existingHtml))
          })
          
          if (isDuplicate) {
            alert('Error: Your edits make this highlight the same as another highlight.')
            return
          }
        }
      }

      // Update in database
      const { error: updateError } = await (supabase
        .from('highlights') as any)
        .update({
          text: editText.trim(),
          html_content: editHtmlContent.trim() || null,
          source: editSource.trim() || null,
          author: editAuthor.trim() || null,
        })
        .eq('id', editingId)

      if (updateError) throw updateError

      // Update categories
      // First, remove existing categories
      await (supabase
        .from('highlight_categories') as any)
        .delete()
        .eq('highlight_id', editingId)

      // Then add new ones
      if (editCategories.length > 0) {
        const categoryLinks = editCategories.map((catId) => ({
          highlight_id: editingId,
          category_id: catId,
        }))
        await (supabase.from('highlight_categories') as any).insert(categoryLinks)
      }

      // Add to Notion sync queue (if configured and not skipped)
      if (!skipNotionSync) {
        await addToSyncQueue(
          editingId,
          'update',
          editText.trim(),
          editHtmlContent.trim() || null,
          originalText,
          originalHtmlContent
        )
      }

      // Refresh search results
      if (query.trim()) {
        await performSearch(query, searchType)
      }

      handleCancelEdit()
    } catch (error) {
      console.error('Error updating highlight:', error)
      alert('Failed to update highlight. Please try again.')
    }
  }

  const handlePin = async (highlightId: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const isPinned = pinnedHighlightIds.has(highlightId)

      if (isPinned) {
        // Unpin
        const response = await fetch(`/api/pins?highlightId=${highlightId}`, {
          method: 'DELETE',
        })

        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || 'Failed to unpin highlight')
        }

        setPinnedHighlightIds((prev) => {
          const next = new Set(prev)
          next.delete(highlightId)
          return next
        })
      } else {
        // Pin
        const response = await fetch('/api/pins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ highlightId }),
        })

        if (!response.ok) {
          const data = await response.json()
          if (data.isFull) {
            // Board is full, show dialog
            setPendingPinHighlightId(highlightId)
            setPinDialogOpen(true)
            return
          }
          throw new Error(data.error || 'Failed to pin highlight')
        }

        setPinnedHighlightIds((prev) => new Set(prev).add(highlightId))
      }
    } catch (error: any) {
      console.error('Error pinning/unpinning highlight:', error)
      alert(error.message || 'Failed to pin/unpin highlight')
    }
  }

  const handleRemoveFromPinBoard = async (highlightIdToRemove: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const response = await fetch(`/api/pins?highlightId=${highlightIdToRemove}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to remove highlight from pin board')
      }

      setPinnedHighlightIds((prev) => {
        const next = new Set(prev)
        next.delete(highlightIdToRemove)
        return next
      })

      // If we have a pending pin, now pin it
      if (pendingPinHighlightId) {
        const pinResponse = await fetch('/api/pins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ highlightId: pendingPinHighlightId }),
        })

        if (pinResponse.ok) {
          setPinnedHighlightIds((prev) => new Set(prev).add(pendingPinHighlightId))
          setPendingPinHighlightId(null)
          setPinDialogOpen(false)
        }
      }
    } catch (error: any) {
      console.error('Error removing from pin board:', error)
      alert(error.message || 'Failed to remove highlight from pin board')
    }
  }

  const handleDelete = async (id: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation() // Prevent triggering highlight click
    }
    if (!confirm('Are you sure you want to delete this highlight?')) return

    try {
      // Get highlight data before deleting (needed for sync queue)
      const allHighlights = [...results, ...similarResults]
      const highlightToDelete = allHighlights.find((h) => h.id === id)
      const text = highlightToDelete?.text || null
      const htmlContent = highlightToDelete?.html_content || null

      // Add to Notion sync queue BEFORE deleting (if configured)
      await addToSyncQueue(
        id,
        'delete',
        text,
        htmlContent
      )

      // Delete from database (CASCADE removes it from daily_summary_highlights, so it won't appear in next month's daily reviews)
      const { error } = await (supabase
        .from('highlights') as any)
        .delete()
        .eq('id', id)

      if (error) throw error

      // Redistribute remaining highlights across future days so next month's daily reviews stay consistent
      await fetch('/api/daily/redistribute', { method: 'POST' })

      // Remove from results
      setResults(results.filter((h) => h.id !== id))
      setSimilarResults(similarResults.filter((h) => h.id !== id))
      
      // If deleted highlight was selected, clear selection
      if (selectedHighlight?.id === id) {
        setSelectedHighlight(null)
      }

      // Refresh search if query exists
      if (query.trim()) {
        await performSearch(query, searchType)
      }
    } catch (error) {
      console.error('Error deleting highlight:', error)
      alert('Failed to delete highlight. Please try again.')
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white">
              Search Highlights
            </h1>
            <Link
              href="/highlights"
              className="flex items-center gap-2 px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition text-sm sm:text-base"
            >
              <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              <span>Back</span>
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg mb-6">
            <div className="flex gap-4 mb-4">
              <div className="flex-1">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search highlights..."
                  className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white text-lg"
                  autoFocus
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setSearchType('fulltext')}
                  className={`px-4 py-3 rounded-lg transition ${
                    searchType === 'fulltext'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                  }`}
                >
                  Full Text
                </button>
                <button
                  onClick={() => setSearchType('semantic')}
                  className={`px-4 py-3 rounded-lg transition ${
                    searchType === 'semantic'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                  }`}
                >
                  Semantic
                </button>
              </div>
            </div>
            {query && (
              <div className="text-sm text-gray-600 dark:text-gray-400">
                {loading ? (
                  <span>Searching...</span>
                ) : (
                  <span>
                    Found {results.length} result{results.length !== 1 ? 's' : ''}
                    {similarResults.length > 0 && `, ${similarResults.length} similar`}
                  </span>
                )}
              </div>
            )}
          </div>

          {query && !loading && results.length === 0 && similarResults.length === 0 && (
            <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-lg text-center text-gray-500 dark:text-gray-400">
              No results found. Try different keywords or switch to semantic search.
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            {/* Search Results */}
            <div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
                Search Results
              </h2>
              <div className="space-y-4">
                {results.map((highlight) => (
                  <div
                    key={highlight.id}
                    className={`bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg transition ${
                      selectedHighlight?.id === highlight.id
                        ? 'ring-2 ring-blue-500'
                        : 'hover:shadow-xl'
                    } ${editingId === highlight.id ? '' : 'cursor-pointer'}`}
                    onClick={() => editingId !== highlight.id && handleHighlightClick(highlight)}
                  >
                    {editingId === highlight.id ? (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                            Highlight Text *
                          </label>
                          <RichTextEditor
                            value={editText}
                            htmlValue={editHtmlContent}
                            onChange={(newText, newHtml) => {
                              setEditText(newText)
                              setEditHtmlContent(newHtml)
                            }}
                            placeholder="Enter your highlight with formatting..."
                          />
                        </div>
                        <div className="grid md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              Source (optional)
                            </label>
                            <input
                              type="text"
                              value={editSource}
                              onChange={(e) => setEditSource(e.target.value)}
                              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                              placeholder="Book, article, etc."
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              Author (optional)
                            </label>
                            <input
                              type="text"
                              value={editAuthor}
                              onChange={(e) => setEditAuthor(e.target.value)}
                              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                              placeholder="Author name"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                            Categories
                          </label>
                          <div className="flex flex-wrap gap-2">
                            {categories.map((cat) => (
                              <button
                                key={cat.id}
                                type="button"
                                onClick={() => {
                                  if (editCategories.includes(cat.id)) {
                                    setEditCategories(editCategories.filter((id) => id !== cat.id))
                                  } else {
                                    setEditCategories([...editCategories, cat.id])
                                  }
                                }}
                                className={`px-3 py-1 rounded-full text-sm transition ${
                                  editCategories.includes(cat.id)
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                                }`}
                              >
                                {cat.name}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={skipNotionSync}
                              onChange={(e) => setSkipNotionSync(e.target.checked)}
                              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">
                              Don&apos;t sync to Notion
                            </span>
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleSaveEdit}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                          >
                            Save
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
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
                        {(highlight.source || highlight.author || (highlight as any).assigned_date) && (
                          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                            {(highlight as any).assigned_date && (
                              <span className="text-gray-500 dark:text-gray-400">
                                Review on {(() => {
                                  const raw = (highlight as any).assigned_date
                                  const [, m, d] = String(raw).split('T')[0].split('-').map(Number)
                                  return `${m}/${d}`
                                })()}
                              </span>
                            )}
                            {(highlight as any).assigned_date && (highlight.author || highlight.source) && <span> • </span>}
                            {highlight.author && <span>{highlight.author}</span>}
                            {highlight.author && highlight.source && <span> • </span>}
                            {highlight.source && <span>{highlight.source}</span>}
                          </p>
                        )}
                        <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handlePin(highlight.id)
                            }}
                            className={`px-3 py-1 text-sm rounded transition ${
                              pinnedHighlightIds.has(highlight.id)
                                ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-800'
                                : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                            }`}
                            title={pinnedHighlightIds.has(highlight.id) ? 'Unpin' : 'Pin'}
                          >
                            {pinnedHighlightIds.has(highlight.id) ? (
                              <PinOff className="w-4 h-4" />
                            ) : (
                              <Pin className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            onClick={(e) => handleStartEdit(highlight, e)}
                            className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                          >
                            Edit
                          </button>
                          <button
                            onClick={(e) => handleDelete(highlight.id, e)}
                            className="px-3 py-1 text-sm bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-800 transition"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Similar Highlights */}
            <div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
                {selectedHighlight ? 'Similar Highlights' : 'Select a highlight to see similar ones'}
              </h2>
              {selectedHighlight && (
                <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                  <p className="text-sm text-blue-800 dark:text-blue-200 font-semibold mb-2">
                    Finding highlights similar to:
                  </p>
                  <div
                    className="highlight-content text-sm prose dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{
                      __html: selectedHighlight.html_content || selectedHighlight.text,
                    }}
                  />
                </div>
              )}
              <div className="space-y-4">
                {similarResults.map((highlight) => (
                  <div
                    key={highlight.id}
                    className={`bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg transition ${
                      editingId === highlight.id ? '' : 'hover:shadow-xl cursor-pointer'
                    }`}
                    onClick={() => editingId !== highlight.id && handleHighlightClick(highlight)}
                  >
                    {editingId === highlight.id ? (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                            Highlight Text *
                          </label>
                          <RichTextEditor
                            value={editText}
                            htmlValue={editHtmlContent}
                            onChange={(newText, newHtml) => {
                              setEditText(newText)
                              setEditHtmlContent(newHtml)
                            }}
                            placeholder="Enter your highlight with formatting..."
                          />
                        </div>
                        <div className="grid md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              Source (optional)
                            </label>
                            <input
                              type="text"
                              value={editSource}
                              onChange={(e) => setEditSource(e.target.value)}
                              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                              placeholder="Book, article, etc."
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              Author (optional)
                            </label>
                            <input
                              type="text"
                              value={editAuthor}
                              onChange={(e) => setEditAuthor(e.target.value)}
                              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                              placeholder="Author name"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                            Categories
                          </label>
                          <div className="flex flex-wrap gap-2">
                            {categories.map((cat) => (
                              <button
                                key={cat.id}
                                type="button"
                                onClick={() => {
                                  if (editCategories.includes(cat.id)) {
                                    setEditCategories(editCategories.filter((id) => id !== cat.id))
                                  } else {
                                    setEditCategories([...editCategories, cat.id])
                                  }
                                }}
                                className={`px-3 py-1 rounded-full text-sm transition ${
                                  editCategories.includes(cat.id)
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                                }`}
                              >
                                {cat.name}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={skipNotionSync}
                              onChange={(e) => setSkipNotionSync(e.target.checked)}
                              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">
                              Don&apos;t sync to Notion
                            </span>
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleSaveEdit}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                          >
                            Save
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
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
                        {(highlight.source || highlight.author || (highlight as any).assigned_date) && (
                          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                            {(highlight as any).assigned_date && (
                              <span className="text-gray-500 dark:text-gray-400">
                                Review on {(() => {
                                  const raw = (highlight as any).assigned_date
                                  const [, m, d] = String(raw).split('T')[0].split('-').map(Number)
                                  return `${m}/${d}`
                                })()}
                              </span>
                            )}
                            {(highlight as any).assigned_date && (highlight.author || highlight.source) && <span> • </span>}
                            {highlight.author && <span>{highlight.author}</span>}
                            {highlight.author && highlight.source && <span> • </span>}
                            {highlight.source && <span>{highlight.source}</span>}
                          </p>
                        )}
                        <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={(e) => handleStartEdit(highlight, e)}
                            className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                          >
                            Edit
                          </button>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation()
                              try {
                                // Update in database (no Notion sync - archive status not supported by Notion)
                                await (supabase
                                  .from('highlights') as any)
                                  .update({ archived: true })
                                  .eq('id', highlight.id)
                                
                                // Remove from results
                                setResults(results.filter((h) => h.id !== highlight.id))
                                setSimilarResults(similarResults.filter((h) => h.id !== highlight.id))
                                
                                // Refresh search if query exists
                                if (query.trim()) {
                                  await performSearch(query, searchType)
                                }
                              } catch (error) {
                                console.error('Error archiving highlight:', error)
                                alert('Failed to archive highlight. Please try again.')
                              }
                            }}
                            className="px-3 py-1 text-sm bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 rounded hover:bg-orange-200 dark:hover:bg-orange-800 transition"
                          >
                            Archive
                          </button>
                          <button
                            onClick={(e) => handleDelete(highlight.id, e)}
                            className="px-3 py-1 text-sm bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-800 transition"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {selectedHighlight && similarResults.length === 0 && (
                  <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                    No similar highlights found.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <PinDialog
        isOpen={pinDialogOpen}
        onClose={() => {
          setPinDialogOpen(false)
          setPendingPinHighlightId(null)
        }}
        onSelectRemove={handleRemoveFromPinBoard}
        onCancel={() => {
          setPinDialogOpen(false)
          setPendingPinHighlightId(null)
        }}
      />
    </main>
  )
}

