'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Highlight, Category } from '@/types/database'
import Link from 'next/link'
import RichTextEditor from '@/components/RichTextEditor'
import PinDialog from '@/components/PinDialog'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { Pin, PinOff } from 'lucide-react'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import NotionSyncButton from '@/components/NotionSyncButton'
import { callRedistribute } from '@/lib/redistribute'
import { parseIntoParagraphs, groupParagraphsByDividers, ParagraphBlock, splitHtmlByBlankLines } from '@/lib/splitHighlightText'
import { renderHighlightHtml } from '@/lib/renderHighlightHtml'

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
  const [dupeNotice, setDupeNotice] = useState<string | null>(null)
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)
  const supabase = createClient()

  // Split state
  const [splitMode, setSplitMode] = useState(false)
  const [splitHighlightId, setSplitHighlightId] = useState<string | null>(null)
  const [splitParagraphs, setSplitParagraphs] = useState<ParagraphBlock[]>([])
  const [splitPoints, setSplitPoints] = useState<Set<number>>(new Set())
  const [splittingInProgress, setSplittingInProgress] = useState(false)

  // Fullscreen composer for the "add new highlight" form
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!fullscreen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [fullscreen])

  const editingHighlight = editingId ? highlights.find((h) => h.id === editingId) : null
  const hasUnsavedNewHighlight = text.trim() !== ''
  const hasUnsavedEdit =
    editingId &&
    editingHighlight &&
    (editText !== editingHighlight.text ||
      (editHtmlContent || editText) !== (editingHighlight.html_content || editingHighlight.text) ||
      (() => {
        const orig = (editingHighlight.categories?.map((c) => c.id) || []).slice().sort()
        const curr = [...editCategories].sort()
        return orig.length !== curr.length || orig.some((id, i) => id !== curr[i])
      })())
  const hasUnsavedChanges = hasUnsavedNewHighlight || !!hasUnsavedEdit
  useUnsavedChanges(hasUnsavedChanges)

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
      // The previous version of this query embedded `daily_assignments` for every
      // highlight (one row per (highlight, day)). With a few thousand highlights
      // that became megabytes of joined rows and pushed page load past 30s.
      // We now fetch only what's needed for the list view, and pull current-month
      // assignments in a single small follow-up query below.
      // Note: we used to pass { count: 'exact' } here. Postgres has to run a
      // sequential scan to satisfy that, and we override the total with the
      // client-filtered count anyway (see setTotalHighlights below), so it
      // was pure cost.
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
          )
        `)
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
      const currentMonthStart = `${year}-${String(month).padStart(2, '0')}-01`
      const currentMonthEnd = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`

      // Small focused query: only this month's daily_summaries + their assignments.
      // Replaces the heavy nested join from the previous version of loadHighlights.
      const currentAssignments = new Map<string, { date: string; rating: 'low' | 'med' | 'high' | null }>()
      try {
        const { data: monthSummaries } = await (supabase
          .from('daily_summaries') as any)
          .select('date, daily_summary_highlights(highlight_id, rating)')
          .eq('user_id', user.id)
          .gte('date', currentMonthStart)
          .lte('date', currentMonthEnd)
        for (const ds of (monthSummaries || []) as Array<{ date: string; daily_summary_highlights: Array<{ highlight_id: string; rating: 'low' | 'med' | 'high' | null }> }>) {
          for (const dsh of ds.daily_summary_highlights || []) {
            currentAssignments.set(dsh.highlight_id, { date: ds.date, rating: dsh.rating })
          }
        }
      } catch (e) {
        console.warn('Failed to load current-month assignments:', e)
      }

      let processedHighlights = (data || []).map((h: any) => {
        // Ensure months_reviewed is an array and properly formatted
        const monthsReviewed = (Array.isArray(h.months_reviewed)
          ? h.months_reviewed.map((mr: any) => ({
              id: mr.id,
              month_year: mr.month_year || (typeof mr === 'string' ? mr : null),
              created_at: mr.created_at,
            }))
          : []
        )
          .filter((mr: { month_year: string | null }) => !!mr.month_year)
          .sort((a: { month_year: string }, b: { month_year: string }) => a.month_year.localeCompare(b.month_year))

        // Current month's assignment (date + rating) comes from the small follow-up query above
        const currentAssignment = currentAssignments.get(h.id)
        const assignedDate = currentAssignment?.date || null
        const hasRatingThisMonth = currentAssignment?.rating != null

        const reviewedForCurrentMonth =
          hasRatingThisMonth ||
          monthsReviewed.some((mr: { month_year: string }) => mr.month_year === currentMonth)

        return {
          ...h,
          categories: h.highlight_categories?.map((hc: any) => hc.category) || [],
          linked_highlights: h.highlight_links_from || [],
          months_reviewed: monthsReviewed,
          assigned_date: assignedDate,
          reviewedForCurrentMonth,
        }
      })

      // Filter by review status for current month BEFORE pagination.
      // Consider "reviewed" if highlight_months_reviewed has this month OR this month's assignment has a rating.
      if (reviewFilter === 'reviewed') {
        processedHighlights = processedHighlights.filter((h: any) => h.reviewedForCurrentMonth === true)
      } else if (reviewFilter === 'not-reviewed') {
        processedHighlights = processedHighlights.filter((h: any) => h.reviewedForCurrentMonth !== true)
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

    // Get authenticated user up front — needed for user_id on rows.
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      alert('You must be logged in to add highlights')
      return
    }

    // Split a single submission into multiple highlights on blank-line separators
    const pieces = splitHtmlByBlankLines(highlightHtml, highlightText)
    if (pieces.length === 0) return

    // Build rows with client-side IDs so the optimistic UI and any background
    // writes (categories, redistribute) can reference them before the insert
    // round-trips. Dedup is intentionally NOT done against the DB here — that
    // round-trip dominated the perceived save latency. Users can spot and
    // delete accidental duplicates from this same view.
    const nowIso = new Date().toISOString()
    const rows = pieces.map((p) => ({
      id: crypto.randomUUID(),
      text: p.text,
      html_content: p.html || null,
      resurface_count: 0,
      average_rating: 0,
      rating_count: 0,
      user_id: user.id,
      archived: false as const,
      created_at: nowIso,
    }))

    // Build the optimistic Highlight objects (categories looked up locally
    // from already-loaded `categories` state).
    const catLookup = new Map(categories.map((c) => [c.id, c]))
    const selectedCategoryObjects = selectedCats
      .map((id) => catLookup.get(id))
      .filter((c): c is Category => !!c)

    const optimisticHighlights = rows.map((r) => ({
      ...r,
      source: null,
      author: null,
      categories: selectedCategoryObjects,
      linked_highlights: [],
      months_reviewed: [],
      assigned_date: null,
      reviewedForCurrentMonth: false,
    })) as unknown as Highlight[]

    // Apply optimistic UI immediately: prepend new rows, bump count, clear the form.
    setHighlights((prev) => [...optimisticHighlights, ...prev])
    setTotalHighlights((prev) => prev + rows.length)
    setText('')
    setHtmlContent('')
    setSelectedCategories([])
    setSaveSuccess(true)
    setTimeout(() => setSaveSuccess(false), 1500)

    // Fire the real writes in the background. Keep `saving` true only as long
    // as the form was being submitted — the user can keep typing the next one.
    setSaving(true)

    ;(async () => {
      try {
        // Postgres-side dedup: the unique constraint on (user_id, text_hash)
        // makes this an `INSERT ... ON CONFLICT DO NOTHING RETURNING id`.
        // Rows that collide with an existing highlight are silently dropped;
        // we detect them by diffing the returned IDs against what we sent.
        const { data: insertedRows, error: insertError } = await (supabase
          .from('highlights') as any)
          .upsert(rows, {
            onConflict: 'user_id,text_hash',
            ignoreDuplicates: true,
          })
          .select('id')
        if (insertError) throw insertError

        const insertedIds = new Set(
          ((insertedRows || []) as Array<{ id: string }>).map((r) => r.id)
        )
        const droppedRows = rows.filter((r) => !insertedIds.has(r.id))

        if (droppedRows.length > 0) {
          // Roll the dropped optimistic rows back out of the list and warn softly.
          const droppedIds = new Set(droppedRows.map((r) => r.id))
          setHighlights((prev) => prev.filter((h) => !droppedIds.has(h.id)))
          setTotalHighlights((prev) => Math.max(0, prev - droppedRows.length))
          setDupeNotice(
            droppedRows.length === rows.length
              ? rows.length === 1
                ? 'Already added — duplicate skipped.'
                : `All ${rows.length} were duplicates — nothing new added.`
              : `${droppedRows.length} duplicate${droppedRows.length === 1 ? '' : 's'} skipped.`
          )
          window.setTimeout(() => setDupeNotice(null), 4000)
        }

        const insertedSourceRows = rows.filter((r) => insertedIds.has(r.id))

        // Categories — only for rows that actually inserted.
        if (selectedCats.length > 0 && insertedSourceRows.length > 0) {
          const categoryLinks = insertedSourceRows.flatMap((r) =>
            selectedCats.map((catId) => ({ highlight_id: r.id, category_id: catId }))
          )
          ;(supabase.from('highlight_categories') as any)
            .insert(categoryLinks)
            .catch((err: any) => console.error('Error adding categories:', err))
        }

        // Notion queue + redistribute, again only for the rows that landed.
        for (const r of insertedSourceRows) {
          addToSyncQueue(r.id, 'add', r.text, r.html_content).catch((err: any) =>
            console.error('Error adding to sync queue:', err)
          )
        }
        if (insertedSourceRows.length > 0) {
          callRedistribute(insertedSourceRows.map((r) => r.id)).catch(() => {})
        }
      } catch (error) {
        console.error('Error adding highlight:', error)
        const failedIds = new Set(rows.map((r) => r.id))
        setHighlights((prev) => prev.filter((h) => !failedIds.has(h.id)))
        setTotalHighlights((prev) => Math.max(0, prev - rows.length))
        // Restore form so the user can retry without losing what they typed
        setText(highlightText)
        setHtmlContent(highlightHtml || '')
        setSelectedCategories(selectedCats)
        alert('Failed to add highlight. Please check your Supabase configuration.')
      } finally {
        setSaving(false)
      }
    })()
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

    const highlightToDelete = highlights.find((h) => h.id === id)
    if (!highlightToDelete) return
    const text = highlightToDelete.text || null
    const htmlContent = highlightToDelete.html_content || null

    // Optimistic removal — pull the row from the list right away.
    setHighlights((prev) => prev.filter((h) => h.id !== id))
    setTotalHighlights((prev) => Math.max(0, prev - 1))

    ;(async () => {
      try {
        const { error } = await (supabase
          .from('highlights') as any)
          .delete()
          .eq('id', id)
        if (error) throw error

        // Only enqueue the Notion delete after the DB delete actually succeeded —
        // otherwise we can wipe the highlight from Notion while it's still in Supabase.
        addToSyncQueue(id, 'delete', text, htmlContent).catch((err) =>
          console.error('Error queueing Notion delete:', err)
        )

        // Redistribute remaining highlights so future daily reviews stay consistent.
        callRedistribute().catch(() => {})
      } catch (error) {
        console.error('Error deleting highlight:', error)
        // Revert the optimistic delete if the DB delete failed.
        setHighlights((prev) => [highlightToDelete, ...prev])
        setTotalHighlights((prev) => prev + 1)
        alert('Failed to delete highlight. Please try again.')
      }
    })()
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

    const id = editingId
    const newText = editText.trim()
    const newHtml = editHtmlContent.trim() || null
    const newCategoryIds = [...editCategories]

    const originalHighlight = highlights.find((h) => h.id === id)
    if (!originalHighlight) return
    const originalText = originalHighlight.text || null
    const originalHtmlContent = originalHighlight.html_content || null
    const originalCategories = originalHighlight.categories || []
    const textChanged =
      newText !== (originalText || '') ||
      newHtml !== (originalHtmlContent || null)

    // Look up new category objects from local state so the optimistic row
    // shows the right pills immediately.
    const catLookup = new Map(categories.map((c) => [c.id, c]))
    const newCategoryObjects = newCategoryIds
      .map((cid) => catLookup.get(cid))
      .filter((c): c is Category => !!c)

    // Apply the edit locally and close the editor right away.
    setHighlights((prev) =>
      prev.map((h) =>
        h.id === id
          ? {
              ...h,
              text: newText,
              html_content: newHtml ?? undefined,
              categories: newCategoryObjects,
            }
          : h
      )
    )
    handleCancelEdit()

    setUpdatingNotion(true)

    ;(async () => {
      try {
        // Run the row update and the category swap in parallel — the row
        // update is the bottleneck and there's no ordering dependency.
        const updateRow = (supabase.from('highlights') as any)
          .update({
            text: newText,
            html_content: newHtml,
            // "Don't sync to Notion": bump the opt-out marker so the
            // enqueue_notion_sync DB trigger skips this one edit.
            ...(skipNotionSync ? { notion_optout_marker: crypto.randomUUID() } : {}),
          })
          .eq('id', id)

        const deleteCats = (supabase.from('highlight_categories') as any)
          .delete()
          .eq('highlight_id', id)

        const [updateResult, deleteResult] = await Promise.all([updateRow, deleteCats])
        if (updateResult.error) throw updateResult.error
        if (deleteResult.error) throw deleteResult.error

        if (newCategoryIds.length > 0) {
          const categoryLinks = newCategoryIds.map((cid) => ({
            highlight_id: id,
            category_id: cid,
          }))
          const { error: insertError } = await (supabase
            .from('highlight_categories') as any)
            .insert(categoryLinks)
          if (insertError) throw insertError
        }

        if (!skipNotionSync && textChanged) {
          addToSyncQueue(
            id,
            'update',
            newText,
            newHtml,
            originalText,
            originalHtmlContent
          ).catch((err) => console.error('Error queueing Notion update:', err))
        }
      } catch (error: any) {
        console.error('Error updating highlight:', error)
        // Revert optimistic edit on failure.
        setHighlights((prev) =>
          prev.map((h) =>
            h.id === id
              ? {
                  ...h,
                  text: originalText || '',
                  html_content: originalHtmlContent ?? undefined,
                  categories: originalCategories,
                }
              : h
          )
        )
        // Postgres unique-violation = 23505. Surface as the soft dupe notice
        // rather than a generic alert.
        if (error?.code === '23505') {
          setDupeNotice('Edit collides with another highlight — change reverted.')
          window.setTimeout(() => setDupeNotice(null), 4000)
        } else {
          alert('Failed to update highlight. Please try again.')
        }
      } finally {
        setUpdatingNotion(false)
      }
    })()
  }

  // ─── Split ────────────────────────────────────────────────

  const handleStartSplit = (highlight: any) => {
    const paragraphs = parseIntoParagraphs(highlight.html_content, highlight.text)
    if (paragraphs.length <= 1) {
      alert('This highlight has only one paragraph — nothing to split.')
      return
    }
    setSplitHighlightId(highlight.id)
    setSplitParagraphs(paragraphs)
    setSplitPoints(new Set())
    setSplitMode(true)
  }

  const handleToggleSplitPoint = (index: number) => {
    setSplitPoints((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const handleCancelSplit = () => {
    setSplitMode(false)
    setSplitHighlightId(null)
    setSplitParagraphs([])
    setSplitPoints(new Set())
  }

  const handleConfirmSplit = async () => {
    if (!splitHighlightId || splitPoints.size === 0) return
    setSplittingInProgress(true)
    try {
      const groups = groupParagraphsByDividers(splitParagraphs, splitPoints)
      if (groups.length <= 1) {
        alert('No split points selected.')
        setSplittingInProgress(false)
        return
      }

      const highlight = highlights.find((h) => h.id === splitHighlightId)
      if (!highlight) throw new Error('Highlight not found')

      const originalText = highlight.text
      const originalHtmlContent = highlight.html_content

      // Update original highlight with first group
      const firstGroup = groups[0]
      const { error: firstGroupUpdateError } = await (supabase.from('highlights') as any)
        .update({ text: firstGroup.text, html_content: firstGroup.html })
        .eq('id', highlight.id)
      if (firstGroupUpdateError) throw firstGroupUpdateError

      await addToSyncQueue(
        highlight.id, 'update',
        firstGroup.text, firstGroup.html,
        originalText, originalHtmlContent
      )

      // Create new highlights for remaining groups
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      const newHighlightIds: string[] = []
      for (let i = 1; i < groups.length; i++) {
        const group = groups[i]
        const { data: newHighlight, error } = await (supabase.from('highlights') as any)
          .insert({
            text: group.text,
            html_content: group.html,
            source: highlight.source || null,
            author: highlight.author || null,
            resurface_count: 0,
            average_rating: 0,
            rating_count: 0,
            user_id: user.id,
          })
          .select()
          .single()

        if (error) throw error
        newHighlightIds.push(newHighlight.id)

        // Copy categories
        if (highlight.categories && highlight.categories.length > 0) {
          const categoryLinks = highlight.categories.map((cat: any) => ({
            highlight_id: newHighlight.id,
            category_id: cat.id,
          }))
          await (supabase.from('highlight_categories') as any).insert(categoryLinks)
        }

        // Sync to Notion
        addToSyncQueue(newHighlight.id, 'add', group.text, group.html)
          .catch((err: any) => console.error('Error syncing split highlight:', err))
      }

      // Redistribute new highlights
      if (newHighlightIds.length > 0) {
        callRedistribute(newHighlightIds).catch(() => {})
      }

      handleCancelSplit()
      await loadHighlights()
    } catch (error) {
      console.error('Error splitting highlight:', error)
      alert('Failed to split highlight. Please try again.')
    } finally {
      setSplittingInProgress(false)
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
    <main className="min-h-screen" style={{ background: 'var(--background)' }}>
      <div className="container mx-auto px-4 py-8 sm:py-10">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6 sm:mb-8">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
                {showArchived ? 'Archived Highlights' : 'My Highlights'}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <NotionSyncButton />
                <button
                  onClick={() => setShowArchived(!showArchived)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-full transition-all text-sm font-medium ${
                    showArchived
                      ? 'bg-amber-500 text-white shadow-sm'
                      : 'btn-secondary !rounded-full !py-2 !px-3.5'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                  </svg>
                  <span className="hidden sm:inline">{showArchived ? 'Show Active' : 'Show Archived'}</span>
                  <span className="sm:hidden">{showArchived ? 'Active' : 'Archived'}</span>
                </button>
                <select
                  value={reviewFilter}
                  onChange={(e) => setReviewFilter(e.target.value as 'all' | 'reviewed' | 'not-reviewed')}
                  className="input-boxed-elegant !rounded-full !py-2 !px-3.5 !text-sm !w-auto"
                >
                  <option value="all">All</option>
                  <option value="reviewed">Reviewed</option>
                  <option value="not-reviewed">Not Reviewed</option>
                </select>
                <button
                  onClick={() => setShowCategoryFilter(!showCategoryFilter)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-full transition-all text-sm font-medium ${
                    showCategoryFilter || selectedFilterCategories.length > 0 || excludedCategories.length > 0
                      ? 'bg-indigo-500 text-white shadow-sm'
                      : 'btn-secondary !rounded-full !py-2 !px-3.5'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                  </svg>
                  <span className="hidden sm:inline">Categories</span>
                  {(selectedFilterCategories.length > 0 || excludedCategories.length > 0) && (
                    <span className="ml-1 px-1.5 py-0.5 bg-white/20 rounded-full text-xs">
                      {selectedFilterCategories.length + excludedCategories.length}
                    </span>
                  )}
                </button>
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

          <form
            onSubmit={handleSubmit}
            className={
              fullscreen
                ? 'fixed inset-0 z-50 flex flex-col p-4 sm:p-6 bg-white dark:bg-gray-900 fullscreen-zoom-in'
                : 'mb-6 sm:mb-8 bg-white dark:bg-gray-800 p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700'
            }
          >
            <div className={fullscreen ? 'flex-1 flex flex-col min-h-0 gap-4' : 'space-y-4'}>
              <div className={fullscreen ? 'flex-1 flex flex-col min-h-0' : ''}>
                <RichTextEditor
                  value={text}
                  htmlValue={htmlContent}
                  onChange={(newText, newHtml) => {
                    setText(newText)
                    setHtmlContent(newHtml)
                  }}
                  placeholder="What do you want to remember?"
                  fullscreen={fullscreen}
                  onToggleFullscreen={() => setFullscreen((v) => !v)}
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
                        className="input-inline-elegant"
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
                  className="btn-primary w-full sm:w-auto !px-6 !py-3"
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

          {dupeNotice && (
            <div
              role="status"
              className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/15 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
            >
              <svg
                className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span>{dupeNotice}</span>
            </div>
          )}

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
                      Archived (low two months in a row)
                    </div>
                  )}
                  {splitMode && splitHighlightId === highlight.id ? (
                    /* ─── Split UI ─── */
                    <div className="space-y-2 mb-4">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-sm font-semibold text-purple-700 dark:text-purple-300">
                          Tap dividers to set split points
                        </span>
                      </div>
                      <div className="max-h-[28em] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
                        {splitParagraphs.map((para, i) => {
                          let groupIndex = 0
                          for (let j = 0; j < i; j++) {
                            if (splitPoints.has(j)) groupIndex++
                          }
                          const groupColors = [
                            'bg-blue-50 dark:bg-blue-900/20 border-l-blue-400',
                            'bg-green-50 dark:bg-green-900/20 border-l-green-400',
                            'bg-yellow-50 dark:bg-yellow-900/20 border-l-yellow-400',
                            'bg-pink-50 dark:bg-pink-900/20 border-l-pink-400',
                            'bg-purple-50 dark:bg-purple-900/20 border-l-purple-400',
                            'bg-orange-50 dark:bg-orange-900/20 border-l-orange-400',
                          ]
                          const colorClass = groupColors[groupIndex % groupColors.length]
                          return (
                            <div key={i}>
                              <div
                                className={`px-4 py-3 border-l-4 ${colorClass} text-sm text-gray-900 dark:text-gray-100`}
                                dangerouslySetInnerHTML={{ __html: para.html }}
                              />
                              {i < splitParagraphs.length - 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleToggleSplitPoint(i)}
                                  className={`w-full py-1.5 flex items-center justify-center gap-2 transition-all text-xs font-medium ${
                                    splitPoints.has(i)
                                      ? 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 border-y-2 border-dashed border-red-400 dark:border-red-600'
                                      : 'bg-gray-50 dark:bg-gray-800 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300 border-y border-gray-200 dark:border-gray-700'
                                  }`}
                                >
                                  {splitPoints.has(i) ? 'Cut here' : '· · ·'}
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      {splitPoints.size > 0 && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                          Will create {splitPoints.size + 1} highlights
                        </p>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={handleConfirmSplit}
                          disabled={splittingInProgress || splitPoints.size === 0}
                          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {splittingInProgress ? 'Splitting...' : `Split into ${splitPoints.size + 1}`}
                        </button>
                        <button
                          onClick={handleCancelSplit}
                          disabled={splittingInProgress}
                          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : editingId === highlight.id ? (
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
                          className="btn-primary !px-4 !py-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
                        __html: renderHighlightHtml(highlight.html_content, highlight.text),
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
                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mt-4 gap-3">
                    <div className="flex items-start gap-2">
                      {editingId !== highlight.id && (
                        <button
                          onClick={() => handlePin(highlight.id)}
                          className={`p-1 rounded transition flex-shrink-0 ${
                            pinnedHighlightIds.has(highlight.id)
                              ? 'text-yellow-600 dark:text-yellow-400 hover:text-yellow-700 dark:hover:text-yellow-300'
                              : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
                          }`}
                          title={pinnedHighlightIds.has(highlight.id) ? 'Unpin' : 'Pin'}
                        >
                          {pinnedHighlightIds.has(highlight.id) ? (
                            <PinOff className="w-4 h-4" />
                          ) : (
                            <Pin className="w-4 h-4" />
                          )}
                        </button>
                      )}
                      <div className="text-xs text-gray-400 dark:text-gray-500">
                        <div>
                          {(highlight as any).assigned_date && (
                            <span className="text-gray-500 dark:text-gray-400">
                              Review on {(() => {
                                // assigned_date is "YYYY-MM-DD" from DB; parse as local date to avoid UTC-off-by-one
                                const raw = (highlight as any).assigned_date
                                const [y, m, d] = String(raw).split('T')[0].split('-').map(Number)
                                const month = m
                                const day = d
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
                            <span> • Avg Rating: {highlight.average_rating.toFixed(1)}/3</span>
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
                    </div>
                    <div className="flex flex-row flex-wrap gap-2">
                      {editingId !== highlight.id && (
                        <>
                          <button
                            onClick={() => handleStartEdit(highlight)}
                            className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                          >
                          Edit
                          </button>
                          <button
                            onClick={() => handleStartSplit(highlight)}
                            className="px-3 py-1 text-sm bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded hover:bg-purple-200 dark:hover:bg-purple-800 transition"
                            title="Split into multiple highlights"
                          >
                            Split
                          </button>
                          {highlight.archived ? (
                            <button
                              onClick={async () => {
                                try {
                                  // Update in database (no Notion sync - archive status not supported by Notion)
                                  await (supabase
                                    .from('highlights') as any)
                                    .update({ archived: false, unarchived_at: new Date().toISOString() })
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
                                if (!confirm('Are you sure you want to archive this highlight?')) return
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
