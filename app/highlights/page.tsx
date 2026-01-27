'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Highlight, Category } from '@/types/database'
import Link from 'next/link'
import RichTextEditor from '@/components/RichTextEditor'
import PinDialog from '@/components/PinDialog'
import { Pin, PinOff } from 'lucide-react'

export default function HighlightsPage() {
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [htmlContent, setHtmlContent] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showCategoryInput, setShowCategoryInput] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [reviewFilter, setReviewFilter] = useState<'all' | 'reviewed' | 'not-reviewed'>('all')
  const [categoryFilterMode, setCategoryFilterMode] = useState<'or' | 'and'>('or')
  const [selectedFilterCategories, setSelectedFilterCategories] = useState<string[]>([])
  const [excludedCategories, setExcludedCategories] = useState<string[]>([])
  const [showCategoryFilter, setShowCategoryFilter] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(20)
  const [totalHighlights, setTotalHighlights] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editHtmlContent, setEditHtmlContent] = useState('')
  const [editCategories, setEditCategories] = useState<string[]>([])
  const [skipNotionSync, setSkipNotionSync] = useState(false)
  const [updatingNotion, setUpdatingNotion] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)
  const supabase = createClient()

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
      // Check if user has Notion settings configured
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: notionSettings, error: settingsError } = await supabase
        .from('user_notion_settings')
        .select('notion_api_key, notion_page_id, enabled')
        .eq('user_id', user.id)
        .eq('enabled', true)
        .maybeSingle()

      // Only add to queue if settings are configured
      if (settingsError || !notionSettings) {
        return // Silently skip if Notion is not configured
      }

      // Add to sync queue
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

      // For updates, try to store original values if available
      // Note: These columns may need to be added to the database schema
      if (operationType === 'update' && (originalText || originalHtmlContent)) {
        queueItem.original_text = originalText || null
        queueItem.original_html_content = originalHtmlContent || null
      }

      const { error: queueError } = await (supabase
        .from('notion_sync_queue') as any)
        .insert([queueItem])

      if (queueError) {
        console.warn('Failed to add to sync queue:', queueError)
        // Don't throw - this is optional
      }
    } catch (error) {
      console.warn('Error adding to sync queue:', error)
      // Don't throw - this is optional
    }
  }

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

  useEffect(() => {
    loadCategories()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setCurrentPage(1) // Reset to first page when filter changes
  }, [showArchived, reviewFilter, selectedFilterCategories, excludedCategories, categoryFilterMode])

  useEffect(() => {
    loadHighlights()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived, reviewFilter, selectedFilterCategories, excludedCategories, categoryFilterMode, currentPage, itemsPerPage])

  const loadHighlights = async () => {
    try {
      setLoading(true)
      
      // Get authenticated user for filtering
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        setLoading(false)
        return
      }
      
      // Note: We'll calculate the total count after filtering by review status
      // For now, just get all highlights to filter them

      // Get all data first (we need to filter by review status, which requires all highlights)
      // Supabase has a default limit of 1000, so we need to explicitly request more or fetch in batches
      let query = supabase
        .from('highlights')
        .select(`
          *,
          highlight_categories (
            category:categories (*)
          ),
          highlight_links_from:highlight_links!from_highlight_id (
            id,
            to_highlight_id,
            link_text,
            to_highlight:highlights!to_highlight_id (
              id,
              text
            )
          ),
          months_reviewed:highlight_months_reviewed (
            id,
            month_year,
            created_at
          ),
          daily_assignments:daily_summary_highlights (
            id,
            daily_summary:daily_summaries (
              id,
              date
            )
          )
        `, { count: 'exact' })
        .eq('user_id', user.id)

      // Filter by archived status
      if (showArchived) {
        query = query.eq('archived', true)
      } else {
        query = query.eq('archived', false)
      }

      // Fetch all highlights (Supabase default limit is 1000, so we need to handle pagination)
      let allHighlights: any[] = []
      let page = 0
      const pageSize = 1000
      let hasMore = true

      while (hasMore) {
        const from = page * pageSize
        const to = from + pageSize - 1
        
        const { data: pageData, error } = await query
          .order('created_at', { ascending: false })
          .range(from, to)

        if (error) throw error

        if (pageData && pageData.length > 0) {
          allHighlights = [...allHighlights, ...pageData]
          hasMore = pageData.length === pageSize
          page++
        } else {
          hasMore = false
        }
      }

      const data = allHighlights

      // Get current month for filtering (using local timezone)
      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() + 1
      const currentMonth = `${year}-${String(month).padStart(2, '0')}`

      let processedHighlights = (data || []).map((h: any) => {
        // Ensure months_reviewed is an array and properly formatted
        const monthsReviewed = Array.isArray(h.months_reviewed) 
          ? h.months_reviewed.map((mr: any) => ({
              id: mr.id,
              month_year: mr.month_year || (typeof mr === 'string' ? mr : null),
              created_at: mr.created_at
            }))
          : []

        // Get assigned date for current month
        let assignedDate: string | null = null
        if (h.daily_assignments && Array.isArray(h.daily_assignments) && h.daily_assignments.length > 0) {
          // Find assignment for current month
          const currentMonthStart = `${year}-${String(month).padStart(2, '0')}-01`
          const currentMonthEnd = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
          
          const currentMonthAssignment = h.daily_assignments.find((da: any) => {
            const assignmentDate = da.daily_summary?.date
            if (!assignmentDate) return false
            return assignmentDate >= currentMonthStart && assignmentDate <= currentMonthEnd
          })
          
          if (currentMonthAssignment?.daily_summary?.date) {
            assignedDate = currentMonthAssignment.daily_summary.date
          }
        }

        return {
          ...h,
          categories: h.highlight_categories?.map((hc: any) => hc.category) || [],
          linked_highlights: h.highlight_links_from || [],
          months_reviewed: monthsReviewed,
          assigned_date: assignedDate,
        }
      })

      // Filter by review status for current month BEFORE pagination
      if (reviewFilter === 'reviewed') {
        processedHighlights = processedHighlights.filter((h: any) => {
          if (!h.months_reviewed || h.months_reviewed.length === 0) return false
          return h.months_reviewed.some((mr: any) => {
            const monthYear = mr.month_year || (typeof mr === 'string' ? mr : null)
            return monthYear === currentMonth
          })
        })
      } else if (reviewFilter === 'not-reviewed') {
        processedHighlights = processedHighlights.filter((h: any) => {
          if (!h.months_reviewed || h.months_reviewed.length === 0) return true
          return !h.months_reviewed.some((mr: any) => {
            const monthYear = mr.month_year || (typeof mr === 'string' ? mr : null)
            return monthYear === currentMonth
          })
        })
      }

      // Filter by categories
      if (selectedFilterCategories.length > 0) {
        if (categoryFilterMode === 'and') {
          // AND: highlight must have ALL selected categories
          processedHighlights = processedHighlights.filter((h: any) => {
            const highlightCategoryIds = h.categories?.map((cat: any) => cat.id) || []
            return selectedFilterCategories.every((catId) => highlightCategoryIds.includes(catId))
          })
        } else {
          // OR: highlight must have at least ONE selected category
          processedHighlights = processedHighlights.filter((h: any) => {
            const highlightCategoryIds = h.categories?.map((cat: any) => cat.id) || []
            return selectedFilterCategories.some((catId) => highlightCategoryIds.includes(catId))
          })
        }
      }

      // Exclude categories
      if (excludedCategories.length > 0) {
        processedHighlights = processedHighlights.filter((h: any) => {
          const highlightCategoryIds = h.categories?.map((cat: any) => cat.id) || []
          return !excludedCategories.some((catId) => highlightCategoryIds.includes(catId))
        })
      }

      // Update total count based on filtered results
      setTotalHighlights(processedHighlights.length)

      // Apply pagination after filtering
      const from = (currentPage - 1) * itemsPerPage
      const to = from + itemsPerPage - 1
      const paginatedHighlights = processedHighlights.slice(from, to)

      setHighlights(paginatedHighlights)
    } catch (error) {
      console.error('Error loading highlights:', error)
    } finally {
      setLoading(false)
    }
  }

  const totalPages = Math.ceil(totalHighlights / itemsPerPage)

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

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return

    try {
      // Get authenticated user
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        alert('You must be logged in to create categories')
        return
      }

      const { data: categoryData, error } = await (supabase
        .from('categories') as any)
        .insert([{ name: newCategoryName.trim(), user_id: user.id }])
        .select()
        .single()

      if (error) throw error

      const data = categoryData as { id: string; name: string; color?: string; created_at: string }
      setCategories([...categories, data])
      setSelectedCategories([...selectedCategories, data.id])
      setNewCategoryName('')
      setShowCategoryInput(false)
    } catch (error) {
      console.error('Error creating category:', error)
      alert('Failed to create category. It may already exist.')
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim() || saving) return

    const highlightText = text.trim()
    const highlightHtml = htmlContent || null
    const selectedCats = [...selectedCategories]

    try {
      setSaving(true)
      setSaveSuccess(false)
      
      // Get authenticated user
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        alert('You must be logged in to add highlights')
        setSaving(false)
        return
      }

      // Check for duplicate highlights
      const { data: existingHighlights, error: checkError } = await (supabase
        .from('highlights') as any)
        .select('id, text, html_content')
        .eq('user_id', user.id)

      if (checkError) {
        console.error('Error checking for duplicates:', checkError)
      } else if (existingHighlights && existingHighlights.length > 0) {
        // Check if any existing highlight has the same text or html_content
        const isDuplicate = existingHighlights.some((h: any) => 
          h.text === highlightText || h.html_content === highlightHtml
        )
        
        if (isDuplicate) {
          setSaving(false)
          alert('Error: Highlight already added.')
          return
        }
      }

      // Clear form immediately for better UX
      setText('')
      setHtmlContent('')
      setSelectedCategories([])

      // Save to database
      const { data: highlightData, error } = await (supabase
        .from('highlights') as any)
        .insert([
          {
            text: highlightText,
            html_content: highlightHtml,
            resurface_count: 0,
            average_rating: 0,
            rating_count: 0,
            user_id: user.id,
          },
        ])
        .select()
        .single()

      if (error) throw error

      const data = highlightData as { id: string; text: string; html_content: string | null; created_at: string }

      // Add categories (non-blocking)
      if (selectedCats.length > 0) {
        const categoryLinks = selectedCats.map((catId) => ({
          highlight_id: data.id,
          category_id: catId,
        }))

        ;(supabase.from('highlight_categories') as any).insert(categoryLinks).catch((err: any) => {
          console.error('Error adding categories:', err)
        })
      }

      // Add to Notion sync queue (non-blocking)
      addToSyncQueue(
        data.id,
        'add',
        highlightText,
        highlightHtml
      ).catch((err: any) => {
        console.error('Error adding to sync queue:', err)
      })

      // Redistribute daily assignments and then refresh highlights
      fetch('/api/daily/redistribute', {
        method: 'POST',
      })
        .then(() => {
          // Refresh highlights after redistribution completes to show assigned date
          loadHighlights()
        })
        .catch((error) => {
          console.warn('Failed to redistribute daily assignments:', error)
          // Still refresh even if redistribution fails
          loadHighlights()
        })

      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (error) {
      console.error('Error adding highlight:', error)
      // Restore form on error
      setText(highlightText)
      setHtmlContent(highlightHtml || '')
      setSelectedCategories(selectedCats)
      alert('Failed to add highlight. Please check your Supabase configuration.')
    } finally {
      setSaving(false)
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

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this highlight?')) return

    try {
      // Get highlight data before deleting (needed for sync queue)
      const highlightToDelete = highlights.find((h) => h.id === id)
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

      // Reload highlights to refresh count and list
      await loadHighlights()
    } catch (error) {
      console.error('Error deleting highlight:', error)
      alert('Failed to delete highlight. Please try again.')
    }
  }


  const handleStartEdit = (highlight: Highlight) => {
    setEditingId(highlight.id)
    setEditText(highlight.text)
    setEditHtmlContent(highlight.html_content || highlight.text)
    setEditCategories(highlight.categories?.map((c) => c.id) || [])
    setSkipNotionSync(false)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditText('')
    setEditHtmlContent('')
    setEditCategories([])
    setSkipNotionSync(false)
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editText.trim()) return

    try {
      setUpdatingNotion(true)

      // Get original highlight data before updating (needed for sync queue)
      const originalHighlight = highlights.find((h) => h.id === editingId)
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
            setUpdatingNotion(false)
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

      await loadHighlights()
      handleCancelEdit()
    } catch (error) {
      console.error('Error updating highlight:', error)
      alert('Failed to update highlight. Please try again.')
    } finally {
      setUpdatingNotion(false)
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
          <div className="mb-6 sm:mb-8">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4">
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white">
                {showArchived ? 'Archived Highlights' : 'My Highlights'}
              </h1>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setShowArchived(!showArchived)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg transition text-sm ${
                    showArchived
                      ? 'bg-orange-600 text-white'
                      : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                  </svg>
                  <span className="hidden sm:inline">{showArchived ? 'Show Active' : 'Show Archived'}</span>
                  <span className="sm:hidden">{showArchived ? 'Active' : 'Archived'}</span>
                </button>
                <select
                  value={reviewFilter}
                  onChange={(e) => setReviewFilter(e.target.value as 'all' | 'reviewed' | 'not-reviewed')}
                  className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                >
                  <option value="all">All</option>
                  <option value="reviewed">Reviewed</option>
                  <option value="not-reviewed">Not Reviewed</option>
                </select>
                <button
                  onClick={() => setShowCategoryFilter(!showCategoryFilter)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg transition text-sm ${
                    showCategoryFilter || selectedFilterCategories.length > 0 || excludedCategories.length > 0
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                  </svg>
                  <span className="hidden sm:inline">Categories</span>
                  {(selectedFilterCategories.length > 0 || excludedCategories.length > 0) && (
                    <span className="ml-1 px-1.5 py-0.5 bg-white/20 rounded text-xs">
                      {selectedFilterCategories.length + excludedCategories.length}
                    </span>
                  )}
                </button>
                <Link
                  href="/search"
                  className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span className="hidden sm:inline">Search</span>
                </Link>
                <Link
                  href="/"
                  className="flex items-center gap-2 px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition text-sm"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                  <span className="hidden sm:inline">Home</span>
                </Link>
              </div>
            </div>
          </div>

          {showCategoryFilter && (
            <div className="mb-4 p-4 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Filter by Categories</h3>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Mode:</span>
                  <button
                    onClick={() => setCategoryFilterMode('or')}
                    className={`px-3 py-1 rounded text-sm transition ${
                      categoryFilterMode === 'or'
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    OR
                  </button>
                  <button
                    onClick={() => setCategoryFilterMode('and')}
                    className={`px-3 py-1 rounded text-sm transition ${
                      categoryFilterMode === 'and'
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    AND
                  </button>
                </div>
              </div>
              
              {categories.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">No categories available. Create categories to filter highlights.</p>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Include Categories ({categoryFilterMode === 'or' ? 'Any' : 'All'}):
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {categories.map((category) => {
                        const isSelected = selectedFilterCategories.includes(category.id)
                        const isExcluded = excludedCategories.includes(category.id)
                        return (
                          <button
                            key={category.id}
                            onClick={() => {
                              if (isExcluded) {
                                // Remove from excluded if clicking
                                setExcludedCategories(excludedCategories.filter(id => id !== category.id))
                              } else if (isSelected) {
                                // Remove from selected
                                setSelectedFilterCategories(selectedFilterCategories.filter(id => id !== category.id))
                              } else {
                                // Add to selected
                                setSelectedFilterCategories([...selectedFilterCategories, category.id])
                              }
                            }}
                            className={`px-3 py-1.5 rounded-lg text-sm transition ${
                              isSelected
                                ? 'bg-purple-600 text-white'
                                : isExcluded
                                ? 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                                : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                            }`}
                          >
                            {category.name}
                            {isSelected && (
                              <span className="ml-1">✓</span>
                            )}
                            {isExcluded && (
                              <span className="ml-1">✗</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Exclude Categories:
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {categories.map((category) => {
                        const isSelected = selectedFilterCategories.includes(category.id)
                        const isExcluded = excludedCategories.includes(category.id)
                        return (
                          <button
                            key={category.id}
                            onClick={() => {
                              if (isSelected) {
                                // Remove from selected if clicking
                                setSelectedFilterCategories(selectedFilterCategories.filter(id => id !== category.id))
                              } else if (isExcluded) {
                                // Remove from excluded
                                setExcludedCategories(excludedCategories.filter(id => id !== category.id))
                              } else {
                                // Add to excluded
                                setExcludedCategories([...excludedCategories, category.id])
                              }
                            }}
                            className={`px-3 py-1.5 rounded-lg text-sm transition ${
                              isExcluded
                                ? 'bg-red-600 text-white'
                                : isSelected
                                ? 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300'
                                : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                            }`}
                          >
                            {category.name}
                            {isExcluded && (
                              <span className="ml-1">✗</span>
                            )}
                            {isSelected && (
                              <span className="ml-1">✓</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {(selectedFilterCategories.length > 0 || excludedCategories.length > 0) && (
                    <button
                      onClick={() => {
                        setSelectedFilterCategories([])
                        setExcludedCategories([])
                      }}
                      className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition text-sm"
                    >
                      Clear All Filters
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mb-6 sm:mb-8 bg-white dark:bg-gray-800 p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700">
            <div className="space-y-4">
              <div>
                <RichTextEditor
                  value={text}
                  htmlValue={htmlContent}
                  onChange={(newText, newHtml) => {
                    setText(newText)
                    setHtmlContent(newHtml)
                  }}
                  placeholder="What do you want to remember?"
                />
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 flex flex-wrap gap-2">
                  {categories.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => {
                        if (selectedCategories.includes(cat.id)) {
                          setSelectedCategories(selectedCategories.filter((id) => id !== cat.id))
                        } else {
                          setSelectedCategories([...selectedCategories, cat.id])
                        }
                      }}
                      className={`px-3 py-1.5 rounded-full text-sm transition ${
                        selectedCategories.includes(cat.id)
                          ? 'bg-blue-600 text-white shadow-md'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
                  {!showCategoryInput ? (
                    <button
                      type="button"
                      onClick={() => setShowCategoryInput(true)}
                      className="px-3 py-1.5 rounded-full text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition border border-dashed border-gray-300 dark:border-gray-600"
                    >
                      + Category
                    </button>
                  ) : (
                    <div className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleCreateCategory()
                          }
                        }}
                        className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-full text-sm dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="New category"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={handleCreateCategory}
                        className="px-3 py-1.5 bg-blue-600 text-white rounded-full text-sm hover:bg-blue-700 transition"
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowCategoryInput(false)
                          setNewCategoryName('')
                        }}
                        className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-full text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!text.trim() || saving}
                  className="w-full sm:w-auto px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {saving ? (
                    <>
                      <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span>Saving...</span>
                    </>
                  ) : saveSuccess ? (
                    <>
                      <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span>Saved!</span>
                    </>
                  ) : (
                    <span>Save Highlight</span>
                  )}
                </button>
              </div>
            </div>
          </form>

          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
                All Highlights ({totalHighlights})
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
                No highlights yet. Add your first highlight above!
              </div>
            ) : (
              highlights.map((highlight) => (
                <div
                  key={highlight.id}
                  id={`highlight-${highlight.id}`}
                  className={`bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg ${
                    highlight.archived ? 'opacity-60 border-2 border-orange-300 dark:border-orange-700' : ''
                  }`}
                >
                  {highlight.archived && (
                    <div className="mb-2 px-2 py-1 bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 rounded text-xs font-semibold inline-block">
                      Archived (marked low twice)
                    </div>
                  )}
                  {editingId === highlight.id ? (
                    <div className="mb-4 space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                          Highlight Text *
                        </label>
                        <RichTextEditor
                          value={editText}
                          htmlValue={editHtmlContent}
                          onChange={(plainText, html) => {
                            setEditText(plainText)
                            setEditHtmlContent(html)
                          }}
                          placeholder="Enter your highlight..."
                        />
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
                              className={`px-3 py-1 text-sm rounded-full transition ${
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
                          disabled={updatingNotion || !editText.trim()}
                          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                          {updatingNotion ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          disabled={updatingNotion}
                          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="highlight-content text-base mb-3 prose dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{
                        __html: highlight.html_content || highlight.text,
                      }}
                    />
                  )}
                  {highlight.categories && highlight.categories.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                      {highlight.categories.map((cat) => (
                        <span
                          key={cat.id}
                          className="px-2 py-1 text-xs rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200"
                        >
                          {cat.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {highlight.linked_highlights && highlight.linked_highlights.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Linked to:</p>
                      <div className="flex flex-wrap gap-2">
                        {highlight.linked_highlights.map((link) => (
                          <a
                            key={link.id}
                            href={`#highlight-${link.to_highlight_id}`}
                            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                            onClick={(e) => {
                              e.preventDefault()
                              document.getElementById(`highlight-${link.to_highlight_id}`)?.scrollIntoView({ behavior: 'smooth' })
                            }}
                          >
                            {link.link_text || link.to_highlight?.text?.substring(0, 50) || 'Link'}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex justify-between items-center mt-4">
                    <div className="text-xs text-gray-400 dark:text-gray-500">
                      <div>
                        {(highlight as any).assigned_date && (
                          <span className="text-gray-500 dark:text-gray-400">
                            Review on {(() => {
                              const date = new Date((highlight as any).assigned_date)
                              const month = date.getMonth() + 1
                              const day = date.getDate()
                              return `${month}/${day}`
                            })()}
                            {' • '}
                          </span>
                        )}
                        Resurfaced {highlight.resurface_count} time{highlight.resurface_count !== 1 ? 's' : ''}
                        {highlight.last_resurfaced && (
                          <span> • Last: {new Date(highlight.last_resurfaced).toLocaleDateString()}</span>
                        )}
                        {highlight.average_rating !== undefined && highlight.average_rating > 0 && (
                          <span> • Avg Rating: {highlight.average_rating.toFixed(1)}/5</span>
                        )}
                      </div>
                      {highlight.months_reviewed && highlight.months_reviewed.length > 0 && (
                        <div className="mt-1">
                          Months reviewed: {highlight.months_reviewed
                            .map((mr: any) => {
                              const [year, month] = mr.month_year.split('-')
                              const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
                              return `${monthNames[parseInt(month) - 1]} ${year}`
                            })
                            .join(', ')}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {editingId !== highlight.id && (
                        <>
                          <button
                            onClick={() => handlePin(highlight.id)}
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
                            onClick={() => handleStartEdit(highlight)}
                            className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                          >
                            Edit
                          </button>
                          {highlight.archived ? (
                            <button
                              onClick={async () => {
                                try {
                                  // Update in database (no Notion sync - archive status not supported by Notion)
                                  await (supabase
                                    .from('highlights') as any)
                                    .update({ archived: false })
                                    .eq('id', highlight.id)
                                  
                                  await loadHighlights()
                                } catch (error) {
                                  console.error('Error unarchiving highlight:', error)
                                  alert('Failed to unarchive highlight. Please try again.')
                                }
                              }}
                              className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                            >
                              Unarchive
                            </button>
                          ) : (
                            <button
                              onClick={async () => {
                                try {
                                  // Update in database (no Notion sync - archive status not supported by Notion)
                                  await (supabase
                                    .from('highlights') as any)
                                    .update({ archived: true })
                                    .eq('id', highlight.id)
                                  
                                  await loadHighlights()
                                } catch (error) {
                                  console.error('Error archiving highlight:', error)
                                  alert('Failed to archive highlight. Please try again.')
                                }
                              }}
                              className="px-3 py-1 text-sm bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 rounded hover:bg-orange-200 dark:hover:bg-orange-800 transition"
                            >
                              Archive
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(highlight.id)}
                            className="px-3 py-1 text-sm bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-800 transition"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
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
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                    className="px-3 py-1 text-sm bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    First
                  </button>
                  <button
                    onClick={() => setCurrentPage(currentPage - 1)}
                    disabled={currentPage === 1}
                    className="px-3 py-1 text-sm bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <span className="px-3 py-1 text-sm text-gray-700 dark:text-gray-300">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(currentPage + 1)}
                    disabled={currentPage === totalPages}
                    className="px-3 py-1 text-sm bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                  <button
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={currentPage === totalPages}
                    className="px-3 py-1 text-sm bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Last
                  </button>
                </div>
              </div>
            )}
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
