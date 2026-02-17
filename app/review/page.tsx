'use client'

import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Pin, PinOff } from 'lucide-react'
import RichTextEditor from '@/components/RichTextEditor'
import PinDialog from '@/components/PinDialog'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'

interface ReviewHighlight {
  id: string
  daily_summary_id: string
  highlight_id: string
  rating: 'low' | 'med' | 'high' | null
  highlight: {
    id: string
    text: string
    html_content?: string | null
    source?: string | null
    author?: string | null
    archived?: boolean | null
    categories?: { id: string; name: string }[]
  } | null
}

export default function ReviewPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
        <div className="text-xl text-gray-600 dark:text-gray-300">Loading...</div>
      </div>
    }>
      <ReviewPageContent />
    </Suspense>
  )
}

function ReviewPageContent() {
  const [highlights, setHighlights] = useState<ReviewHighlight[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [ratingInProgress, setRatingInProgress] = useState(false)
  const [autoRated, setAutoRated] = useState(false)
  const autoRateProcessed = useRef(false)
  const supabase = createClient()
  const searchParams = useSearchParams()
  const router = useRouter()

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editHtmlContent, setEditHtmlContent] = useState('')
  const [editSource, setEditSource] = useState('')
  const [editAuthor, setEditAuthor] = useState('')
  const [editCategories, setEditCategories] = useState<string[]>([])
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [skipNotionSync, setSkipNotionSync] = useState(false)
  const [updatingNotion, setUpdatingNotion] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showCategoryInput, setShowCategoryInput] = useState(false)

  // Pin state
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)

  const today = format(new Date(), 'yyyy-MM-dd')

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

  const loadHighlights = useCallback(async () => {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        return
      }

      // Run independent queries in parallel
      const [catResult, pinResult, summaryResult] = await Promise.all([
        supabase
          .from('categories')
          .select('id, name')
          .eq('user_id', user.id)
          .order('name'),
        (supabase.from('pinned_highlights') as any)
          .select('highlight_id')
          .eq('user_id', user.id),
        supabase
          .from('daily_summaries')
          .select('id')
          .eq('date', today)
          .eq('user_id', user.id)
          .maybeSingle(),
      ])

      setCategories(catResult.data || [])
      setPinnedHighlightIds(new Set((pinResult.data || []).map((p: any) => p.highlight_id)))

      if (summaryResult.error) throw summaryResult.error
      if (!summaryResult.data) {
        setHighlights([])
        setLoading(false)
        return
      }

      const summary = summaryResult.data as { id: string }

      // Get highlights for this summary
      const { data: summaryHighlights, error: highlightsError } = await supabase
        .from('daily_summary_highlights')
        .select(`
          id,
          highlight_id,
          rating,
          highlight:highlights (
            id,
            text,
            html_content,
            source,
            author,
            archived,
            highlight_categories (
              category:categories (*)
            )
          )
        `)
        .eq('daily_summary_id', summary.id)
        .order('rating', { ascending: false, nullsFirst: true })
        .order('id', { ascending: true })

      if (highlightsError) throw highlightsError

      const processed: ReviewHighlight[] = (summaryHighlights || []).map((sh: any) => ({
        id: sh.id,
        daily_summary_id: summary.id,
        highlight_id: sh.highlight_id,
        rating: sh.rating,
        highlight: sh.highlight
          ? {
              ...sh.highlight,
              categories: sh.highlight.highlight_categories?.map((hc: any) => hc.category) || [],
            }
          : null,
      }))

      // Sort by text length (shortest first) for faster reviewing
      processed.sort((a, b) => {
        const aLen = a.highlight?.text?.length || 0
        const bLen = b.highlight?.text?.length || 0
        return aLen - bLen
      })

      setHighlights(processed)

      // Start at the first unrated highlight
      const firstUnrated = processed.findIndex((h) => h.rating === null)
      setCurrentIndex(firstUnrated >= 0 ? firstUnrated : 0)
    } catch (error) {
      console.error('Error loading highlights:', error)
    } finally {
      setLoading(false)
    }
  }, [supabase, today])

  useEffect(() => {
    loadHighlights()
  }, [loadHighlights])

  // Handle auto-rating and actions from URL params (widget tap)
  useEffect(() => {
    if (autoRateProcessed.current || loading || highlights.length === 0) return

    const rateParam = searchParams.get('rate') as 'low' | 'med' | 'high' | null
    const actionParam = searchParams.get('action') as 'archive' | 'delete' | 'pin' | null
    const idParam = searchParams.get('id')

    if (idParam) {
      autoRateProcessed.current = true

      const targetIndex = highlights.findIndex((h) => h.id === idParam)

      if (targetIndex >= 0) {
        setCurrentIndex(targetIndex)

        if (actionParam === 'archive') {
          setTimeout(async () => {
            await handleArchiveHighlight(highlights[targetIndex].highlight_id)
            router.replace('/review', { scroll: false })
          }, 300)
        } else if (actionParam === 'delete') {
          setTimeout(async () => {
            await handleDeleteHighlight(highlights[targetIndex].highlight_id)
            router.replace('/review', { scroll: false })
          }, 300)
        } else if (actionParam === 'pin') {
          setTimeout(async () => {
            await handlePin(highlights[targetIndex].highlight_id)
            router.replace('/review', { scroll: false })
          }, 300)
        } else if (rateParam && ['low', 'med', 'high'].includes(rateParam) && highlights[targetIndex].rating === null) {
          setTimeout(() => {
            handleRateByIndex(targetIndex, rateParam)
            setAutoRated(true)
            router.replace('/review', { scroll: false })
          }, 300)
        }
      } else {
        router.replace('/review', { scroll: false })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, highlights, searchParams])

  // Helper to rate a specific highlight by index (for auto-rate)
  const handleRateByIndex = async (index: number, rating: 'low' | 'med' | 'high') => {
    const target = highlights[index]
    if (!target || ratingInProgress) return
    setRatingInProgress(true)

    try {
      setHighlights((prev) =>
        prev.map((h) => (h.id === target.id ? { ...h, rating } : h))
      )

      await (supabase.from('daily_summary_highlights') as any)
        .update({ rating })
        .eq('id', target.id)

      const [y, mo] = today.split('-').map(Number)
      const monthYear = `${y}-${String(mo).padStart(2, '0')}`
      await (supabase.from('highlight_months_reviewed') as any)
        .upsert(
          { highlight_id: target.highlight_id, month_year: monthYear },
          { onConflict: 'highlight_id,month_year' }
        )

      const { data: allRatingsData } = await supabase
        .from('daily_summary_highlights')
        .select('rating')
        .eq('highlight_id', target.highlight_id)
        .not('rating', 'is', null)

      const allRatings = (allRatingsData || []) as Array<{ rating: string }>
      const ratingMap: Record<string, number> = { low: 1, med: 2, high: 3 }
      const ratingValues = allRatings.map((r) => ratingMap[r.rating] || 0).filter((v) => v > 0)
      const average = ratingValues.length > 0
        ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
        : 0

      const { data: highlightData } = await (supabase.from('highlights') as any)
        .select('unarchived_at')
        .eq('id', target.highlight_id)
        .single()

      let lowRatingsCount = 0
      if (highlightData?.unarchived_at) {
        const { data: recentLowRatings } = await supabase
          .from('daily_summary_highlights')
          .select('rating, daily_summary:daily_summaries!inner(date)')
          .eq('highlight_id', target.highlight_id)
          .eq('rating', 'low')
          .gt('daily_summary.date', highlightData.unarchived_at.split('T')[0])
        lowRatingsCount = (recentLowRatings || []).length
      } else {
        lowRatingsCount = allRatings.filter((r) => r.rating === 'low').length
      }

      const shouldArchive = lowRatingsCount >= 2

      await (supabase.from('highlights') as any)
        .update({
          average_rating: average,
          rating_count: ratingValues.length,
          ...(shouldArchive ? { archived: true } : {}),
        })
        .eq('id', target.highlight_id)

      const updated = highlights.map((h) =>
        h.id === target.id ? { ...h, rating } : h
      )
      const nextUnrated = updated.findIndex((h) => h.rating === null)
      if (nextUnrated >= 0) {
        setCurrentIndex(nextUnrated)
      }
    } catch (error) {
      console.error('Error auto-rating highlight:', error)
      setHighlights((prev) =>
        prev.map((h) => (h.id === target.id ? { ...h, rating: null } : h))
      )
    } finally {
      setRatingInProgress(false)
    }
  }

  const ratedCount = useMemo(
    () => highlights.filter((h) => h.rating !== null).length,
    [highlights]
  )

  const allDone = highlights.length > 0 && ratedCount === highlights.length

  const current = highlights[currentIndex] || null

  const handleRate = async (rating: 'low' | 'med' | 'high') => {
    if (!current || ratingInProgress) return
    setRatingInProgress(true)

    try {
      setHighlights((prev) =>
        prev.map((h) => (h.id === current.id ? { ...h, rating } : h))
      )

      await (supabase.from('daily_summary_highlights') as any)
        .update({ rating })
        .eq('id', current.id)

      const [y, mo] = today.split('-').map(Number)
      const monthYear = `${y}-${String(mo).padStart(2, '0')}`
      await (supabase.from('highlight_months_reviewed') as any)
        .upsert(
          { highlight_id: current.highlight_id, month_year: monthYear },
          { onConflict: 'highlight_id,month_year' }
        )

      const { data: allRatingsData } = await supabase
        .from('daily_summary_highlights')
        .select('rating')
        .eq('highlight_id', current.highlight_id)
        .not('rating', 'is', null)

      const allRatings = (allRatingsData || []) as Array<{ rating: string }>
      const ratingMap: Record<string, number> = { low: 1, med: 2, high: 3 }
      const ratingValues = allRatings.map((r) => ratingMap[r.rating] || 0).filter((v) => v > 0)
      const average = ratingValues.length > 0
        ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
        : 0

      const { data: highlightData } = await (supabase.from('highlights') as any)
        .select('unarchived_at')
        .eq('id', current.highlight_id)
        .single()

      let lowRatingsCount = 0
      if (highlightData?.unarchived_at) {
        const { data: recentLowRatings } = await supabase
          .from('daily_summary_highlights')
          .select('rating, daily_summary:daily_summaries!inner(date)')
          .eq('highlight_id', current.highlight_id)
          .eq('rating', 'low')
          .gt('daily_summary.date', highlightData.unarchived_at.split('T')[0])
        lowRatingsCount = (recentLowRatings || []).length
      } else {
        lowRatingsCount = allRatings.filter((r) => r.rating === 'low').length
      }

      const shouldArchive = lowRatingsCount >= 2

      await (supabase.from('highlights') as any)
        .update({
          average_rating: average,
          rating_count: ratingValues.length,
          ...(shouldArchive ? { archived: true } : {}),
        })
        .eq('id', current.highlight_id)

      const updated = highlights.map((h) =>
        h.id === current.id ? { ...h, rating } : h
      )
      const nextUnrated = updated.findIndex(
        (h, i) => h.rating === null && i !== currentIndex
      )
      if (nextUnrated >= 0) {
        setCurrentIndex(nextUnrated)
      }
    } catch (error) {
      console.error('Error rating highlight:', error)
      setHighlights((prev) =>
        prev.map((h) => (h.id === current.id ? { ...h, rating: null } : h))
      )
    } finally {
      setRatingInProgress(false)
    }
  }

  const goToNext = () => {
    if (currentIndex < highlights.length - 1) {
      setCurrentIndex(currentIndex + 1)
    }
  }

  const goToPrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
    }
  }

  // ─── Edit ─────────────────────────────────────────────────

  const handleStartEdit = (highlight: any) => {
    setEditingId(highlight.id)
    setEditText(highlight.text)
    setEditHtmlContent(highlight.html_content || highlight.text)
    setEditSource(highlight.source || '')
    setEditAuthor(highlight.author || '')
    setEditCategories(highlight.categories?.map((c: any) => c.id) || [])
    setSkipNotionSync(false)
    setShowCategoryInput(false)
    setNewCategoryName('')
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditText('')
    setEditHtmlContent('')
    setEditSource('')
    setEditAuthor('')
    setEditCategories([])
    setSkipNotionSync(false)
    setShowCategoryInput(false)
    setNewCategoryName('')
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editText.trim()) return
    setUpdatingNotion(true)
    try {
      const highlightId = editingId
      const original = current?.highlight

      await (supabase.from('highlights') as any)
        .update({
          text: editText.trim(),
          html_content: editHtmlContent.trim() || null,
          source: editSource.trim() || null,
          author: editAuthor.trim() || null,
        })
        .eq('id', highlightId)

      // Update categories
      await (supabase.from('highlight_categories') as any).delete().eq('highlight_id', highlightId)
      if (editCategories.length > 0) {
        const categoryLinks = editCategories.map((catId) => ({
          highlight_id: highlightId, category_id: catId,
        }))
        await (supabase.from('highlight_categories') as any).insert(categoryLinks)
      }

      // Notion sync
      if (!skipNotionSync) {
        await addToSyncQueue(
          highlightId, 'update',
          editText.trim(), editHtmlContent.trim() || null,
          original?.text || null, original?.html_content || null
        )
      }

      // Update local state instead of reloading
      const updatedCategories = categories.filter((c) => editCategories.includes(c.id))
      setHighlights((prev) =>
        prev.map((h) =>
          h.highlight_id === highlightId && h.highlight
            ? {
                ...h,
                highlight: {
                  ...h.highlight,
                  text: editText.trim(),
                  html_content: editHtmlContent.trim() || null,
                  source: editSource.trim() || null,
                  author: editAuthor.trim() || null,
                  categories: updatedCategories,
                },
              }
            : h
        )
      )
      handleCancelEdit()
    } catch (error) {
      console.error('Error saving edit:', error)
    } finally {
      setUpdatingNotion(false)
    }
  }

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data, error } = await (supabase.from('categories') as any)
        .insert({ name: newCategoryName.trim(), user_id: user.id })
        .select()
        .single()
      if (error) throw error
      setCategories((prev) => [...prev, data])
      setEditCategories((prev) => [...prev, data.id])
      setNewCategoryName('')
      setShowCategoryInput(false)
    } catch (error) {
      console.error('Error creating category:', error)
    }
  }

  // ─── Archive ──────────────────────────────────────────────

  const handleArchiveHighlight = async (highlightId: string) => {
    if (!confirm('Are you sure you want to archive this highlight?')) return
    try {
      await (supabase.from('highlights') as any)
        .update({ archived: true })
        .eq('id', highlightId)
      setHighlights((prev) =>
        prev.map((h) =>
          h.highlight_id === highlightId && h.highlight
            ? { ...h, highlight: { ...h.highlight, archived: true } }
            : h
        )
      )
    } catch (error) {
      console.error('Error archiving highlight:', error)
    }
  }

  const handleUnarchiveHighlight = async (highlightId: string) => {
    try {
      await (supabase.from('highlights') as any)
        .update({ archived: false, unarchived_at: new Date().toISOString() })
        .eq('id', highlightId)
      setHighlights((prev) =>
        prev.map((h) =>
          h.highlight_id === highlightId && h.highlight
            ? { ...h, highlight: { ...h.highlight, archived: false } }
            : h
        )
      )
    } catch (error) {
      console.error('Error unarchiving highlight:', error)
    }
  }

  // ─── Delete ───────────────────────────────────────────────

  const handleDeleteHighlight = async (highlightId: string) => {
    if (!confirm('Are you sure you want to delete this highlight? This cannot be undone.')) return
    try {
      const h = highlights.find((h) => h.highlight_id === highlightId)
      const text = h?.highlight?.text || null
      const htmlContent = h?.highlight?.html_content || null
      await addToSyncQueue(highlightId, 'delete', text, htmlContent)

      await (supabase.from('highlights') as any).delete().eq('id', highlightId)
      fetch('/api/daily/redistribute', { method: 'POST' }) // fire-and-forget

      setHighlights((prev) => {
        const updated = prev.filter((h) => h.highlight_id !== highlightId)
        return updated
      })
      setCurrentIndex((prev) => Math.min(prev, highlights.length - 2))
    } catch (error) {
      console.error('Error deleting highlight:', error)
      alert('Failed to delete highlight. Please try again.')
    }
  }

  // ─── Pin ──────────────────────────────────────────────────

  const handlePin = async (highlightId: string) => {
    const isPinned = pinnedHighlightIds.has(highlightId)

    if (isPinned) {
      const response = await fetch(`/api/pins?highlightId=${highlightId}`, { method: 'DELETE' })
      if (response.ok) {
        setPinnedHighlightIds((prev) => { const next = new Set(prev); next.delete(highlightId); return next })
      }
    } else {
      const response = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlightId }),
      })
      if (!response.ok) {
        const data = await response.json()
        if (data.isFull) {
          setPendingPinHighlightId(highlightId)
          setPinDialogOpen(true)
          return
        }
      } else {
        setPinnedHighlightIds((prev) => new Set(prev).add(highlightId))
      }
    }
  }

  const handleRemoveFromPinBoard = async (highlightIdToRemove: string) => {
    await fetch(`/api/pins?highlightId=${highlightIdToRemove}`, { method: 'DELETE' })
    setPinnedHighlightIds((prev) => { const next = new Set(prev); next.delete(highlightIdToRemove); return next })

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
  }

  // ─── Render ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
        <div className="text-xl text-gray-600 dark:text-gray-300">Loading...</div>
      </div>
    )
  }

  if (highlights.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-6">
        <p className="text-xl text-gray-600 dark:text-gray-300 mb-6 text-center">
          No highlights to review today.
        </p>
        <Link
          href="/daily"
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
        >
          Go to Daily Review
        </Link>
      </div>
    )
  }

  if (allDone) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-6">
        <div className="text-6xl mb-4">🎉</div>
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2 text-center">
          All Done!
        </h2>
        <p className="text-gray-600 dark:text-gray-300 mb-6 text-center">
          You reviewed all {highlights.length} highlights for today.
        </p>
        <div className="flex gap-3">
          <Link
            href="/"
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
          >
            Home
          </Link>
          <Link
            href="/daily"
            className="px-6 py-3 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition font-medium"
          >
            Daily Review
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 safe-area-top">
        <Link
          href="/"
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
        >
          Home
        </Link>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {ratedCount} / {highlights.length} reviewed
        </div>
        <Link
          href="/daily"
          className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition"
        >
          Full View
        </Link>
      </div>

      {/* Progress bar */}
      <div className="px-4">
        <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${(ratedCount / highlights.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Main card area */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6">
        {current && current.highlight && (
          <div className="w-full max-w-lg">
            {/* Highlight card */}
            <div className={`bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6 mb-4 ${
              current.highlight.archived ? 'opacity-60 border-2 border-orange-300 dark:border-orange-700' : ''
            }`}>
              {current.highlight.archived && (
                <div className="mb-2 px-2 py-1 bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 rounded text-xs font-semibold inline-block">
                  Archived
                </div>
              )}

              {editingId === current.highlight.id ? (
                /* ─── Inline Edit Form ─── */
                <div className="space-y-4">
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

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Source</label>
                      <input type="text" value={editSource} onChange={(e) => setEditSource(e.target.value)}
                        className="input-boxed-elegant" placeholder="Book, article, etc." />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Author</label>
                      <input type="text" value={editAuthor} onChange={(e) => setEditAuthor(e.target.value)}
                        className="input-boxed-elegant" placeholder="Author name" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Categories</label>
                    <div className="flex flex-wrap gap-2">
                      {categories.map((cat) => (
                        <button key={cat.id} type="button"
                          onClick={() => {
                            setEditCategories((prev) =>
                              prev.includes(cat.id) ? prev.filter((c) => c !== cat.id) : [...prev, cat.id]
                            )
                          }}
                          className={`px-3 py-1 rounded-full text-sm transition ${
                            editCategories.includes(cat.id)
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                          }`}
                        >{cat.name}</button>
                      ))}
                      {showCategoryInput ? (
                        <div className="flex gap-1">
                          <input type="text" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCreateCategory()}
                            className="px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600"
                            placeholder="Name" autoFocus />
                          <button onClick={handleCreateCategory}
                            className="px-2 py-1 text-sm bg-blue-600 text-white rounded">Add</button>
                          <button onClick={() => { setShowCategoryInput(false); setNewCategoryName('') }}
                            className="px-2 py-1 text-sm bg-gray-200 dark:bg-gray-700 rounded">Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setShowCategoryInput(true)}
                          className="px-3 py-1 rounded-full text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
                        >+ Category</button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={skipNotionSync} onChange={(e) => setSkipNotionSync(e.target.checked)}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700" />
                      <span className="text-sm text-gray-700 dark:text-gray-300">Don&apos;t sync to Notion</span>
                    </label>
                  </div>

                  <div className="flex gap-2">
                    <button onClick={handleSaveEdit} disabled={updatingNotion || !editText.trim()}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
                      {updatingNotion ? 'Saving...' : 'Save'}
                    </button>
                    <button onClick={handleCancelEdit} disabled={updatingNotion}
                      className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* ─── Normal Display ─── */
                <>
                  {current.highlight.categories && current.highlight.categories.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {current.highlight.categories.map((cat) => (
                        <span
                          key={cat.id}
                          className="px-2 py-0.5 text-xs rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200"
                        >
                          {cat.name}
                        </span>
                      ))}
                    </div>
                  )}

                  <div
                    className="highlight-content text-lg leading-relaxed prose dark:prose-invert max-w-none mb-4 overflow-y-auto"
                    style={{ maxHeight: '24em' }}
                    dangerouslySetInnerHTML={{
                      __html: current.highlight.html_content || current.highlight.text,
                    }}
                  />

                  {(current.highlight.source || current.highlight.author) && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {current.highlight.author && <span>{current.highlight.author}</span>}
                      {current.highlight.author && current.highlight.source && <span> &middot; </span>}
                      {current.highlight.source && <span>{current.highlight.source}</span>}
                    </p>
                  )}

                  {current.rating && (
                    <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        Rated: <span className="font-medium capitalize">{current.rating}</span>
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Rating buttons */}
            {!editingId && (
              <>
                {!current.rating ? (
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleRate('low')}
                      disabled={ratingInProgress}
                      className="flex-1 py-4 text-lg font-semibold rounded-xl transition-all transform hover:scale-105 active:scale-95 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-2 border-red-300 dark:border-red-700 disabled:opacity-50"
                    >
                      Low
                    </button>
                    <button
                      onClick={() => handleRate('med')}
                      disabled={ratingInProgress}
                      className="flex-1 py-4 text-lg font-semibold rounded-xl transition-all transform hover:scale-105 active:scale-95 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-2 border-yellow-300 dark:border-yellow-700 disabled:opacity-50"
                    >
                      Med
                    </button>
                    <button
                      onClick={() => handleRate('high')}
                      disabled={ratingInProgress}
                      className="flex-1 py-4 text-lg font-semibold rounded-xl transition-all transform hover:scale-105 active:scale-95 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-2 border-green-300 dark:border-green-700 disabled:opacity-50"
                    >
                      High
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-3">
                    <button
                      onClick={goToPrev}
                      disabled={currentIndex === 0}
                      className="flex-1 py-3 text-base font-medium rounded-xl bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 transition disabled:opacity-30"
                    >
                      Prev
                    </button>
                    <button
                      onClick={goToNext}
                      disabled={currentIndex === highlights.length - 1}
                      className="flex-1 py-3 text-base font-medium rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-30"
                    >
                      Next
                    </button>
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-2 mt-3 justify-center flex-wrap">
                  <button
                    onClick={() => handleStartEdit(current.highlight)}
                    className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handlePin(current.highlight_id)}
                    className={`px-3 py-1 text-sm rounded transition flex items-center gap-1 ${
                      pinnedHighlightIds.has(current.highlight_id)
                        ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-800'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                    title={pinnedHighlightIds.has(current.highlight_id) ? 'Unpin' : 'Pin'}
                  >
                    {pinnedHighlightIds.has(current.highlight_id) ? (
                      <><PinOff className="w-3.5 h-3.5" /> Unpin</>
                    ) : (
                      <><Pin className="w-3.5 h-3.5" /> Pin</>
                    )}
                  </button>
                  {current.highlight.archived ? (
                    <button
                      onClick={() => handleUnarchiveHighlight(current.highlight_id)}
                      className="px-3 py-1 text-sm bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded hover:bg-green-200 dark:hover:bg-green-800 transition"
                    >
                      Unarchive
                    </button>
                  ) : (
                    <button
                      onClick={() => handleArchiveHighlight(current.highlight_id)}
                      className="px-3 py-1 text-sm bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 rounded hover:bg-orange-200 dark:hover:bg-orange-800 transition"
                    >
                      Archive
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteHighlight(current.highlight_id)}
                    className="px-3 py-1 text-sm bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-800 transition"
                  >
                    Delete
                  </button>
                </div>
              </>
            )}

            {/* Navigation dots */}
            <div className="flex justify-center gap-1.5 mt-6 flex-wrap">
              {highlights.map((h, i) => (
                <button
                  key={h.id}
                  onClick={() => setCurrentIndex(i)}
                  className={`w-2.5 h-2.5 rounded-full transition-all ${
                    i === currentIndex
                      ? 'bg-blue-500 scale-125'
                      : h.rating
                      ? 'bg-green-400 dark:bg-green-600'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                  aria-label={`Highlight ${i + 1}`}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Pin Dialog */}
      <PinDialog
        isOpen={pinDialogOpen}
        onClose={() => { setPinDialogOpen(false); setPendingPinHighlightId(null) }}
        onSelectRemove={handleRemoveFromPinBoard}
        onCancel={() => { setPinDialogOpen(false); setPendingPinHighlightId(null) }}
      />
    </div>
  )
}
