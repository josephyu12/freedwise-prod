'use client'

import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { DailySummaryHighlight } from '@/types/database'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { format } from 'date-fns'

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

  const today = format(new Date(), 'yyyy-MM-dd')

  const loadHighlights = useCallback(async () => {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        return
      }

      // Get today's daily summary
      const { data: summaryData, error: summaryError } = await supabase
        .from('daily_summaries')
        .select('id')
        .eq('date', today)
        .eq('user_id', user.id)
        .maybeSingle()

      if (summaryError) throw summaryError
      if (!summaryData) {
        setHighlights([])
        setLoading(false)
        return
      }

      const summary = summaryData as { id: string }

      // Get highlights for this summary — unrated first, then rated
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

  // Handle auto-rating from URL params (widget tap)
  useEffect(() => {
    if (autoRateProcessed.current || loading || highlights.length === 0) return

    const rateParam = searchParams.get('rate') as 'low' | 'med' | 'high' | null
    const idParam = searchParams.get('id')

    if (rateParam && idParam && ['low', 'med', 'high'].includes(rateParam)) {
      autoRateProcessed.current = true

      // Find the highlight matching the id param
      const targetIndex = highlights.findIndex((h) => h.id === idParam)
      if (targetIndex >= 0 && highlights[targetIndex].rating === null) {
        setCurrentIndex(targetIndex)
        // Rate it after a brief delay so the UI shows the card first
        setTimeout(() => {
          handleRateByIndex(targetIndex, rateParam)
          setAutoRated(true)
          // Clean URL params
          router.replace('/review', { scroll: false })
        }, 300)
      } else {
        // ID not found or already rated, just clean up
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

      // Advance to next unrated
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
      // Optimistic UI update
      setHighlights((prev) =>
        prev.map((h) => (h.id === current.id ? { ...h, rating } : h))
      )

      // Update rating in daily_summary_highlights
      await (supabase.from('daily_summary_highlights') as any)
        .update({ rating })
        .eq('id', current.id)

      // Mark highlight as reviewed for this month
      const [y, mo] = today.split('-').map(Number)
      const monthYear = `${y}-${String(mo).padStart(2, '0')}`
      await (supabase.from('highlight_months_reviewed') as any)
        .upsert(
          { highlight_id: current.highlight_id, month_year: monthYear },
          { onConflict: 'highlight_id,month_year' }
        )

      // Recalculate average rating
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

      // Check for auto-archive (2+ low ratings)
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

      // Auto-advance to next unrated highlight
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
      // Revert optimistic update
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
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6 mb-6">
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
            </div>

            {/* Rating buttons */}
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
    </div>
  )
}
