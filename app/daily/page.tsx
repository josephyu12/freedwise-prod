'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { DailySummary, DailySummaryHighlight, Category } from '@/types/database'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isSameMonth, isSameDay, addMonths, subMonths } from 'date-fns'
import RichTextEditor from '@/components/RichTextEditor'
import PinDialog from '@/components/PinDialog'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { Pin, PinOff } from 'lucide-react'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import OfflineBanner from '@/components/OfflineBanner'
import {
  cacheDailyData,
  getCachedDailyData,
  enqueueOfflineAction,
  getPendingActions,
  removeAction,
} from '@/lib/offlineStore'

function CalendarView({
  selectedDate,
  onDateSelect,
  monthReviewStatus,
  displayMonth,
  onDisplayMonthChange,
  monthsWithAssignments,
}: {
  selectedDate: string
  onDateSelect: (date: string) => void
  monthReviewStatus: Map<string, 'completed' | 'partial' | 'none'>
  displayMonth: Date
  onDisplayMonthChange: (month: Date) => void
  monthsWithAssignments: Set<string> // Set of month strings in 'YYYY-MM' format
}) {
  const monthStart = startOfMonth(displayMonth)
  const monthEnd = endOfMonth(displayMonth)
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd })
  const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  
  // Get first day of week for the month
  const firstDayOfWeek = getDay(monthStart)
  const emptyDays = Array(firstDayOfWeek).fill(null)

  // Check if this month has assignments
  // Normalize displayMonth to start of month for consistent comparison
  const normalizedDisplayMonth = startOfMonth(displayMonth)
  const monthKey = format(normalizedDisplayMonth, 'yyyy-MM')
  const hasAssignments = monthsWithAssignments.has(monthKey)

  const getStatusText = (dayDate: Date) => {
    // Format as YYYY-MM-DD using local timezone
    const dateStr = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, '0')}-${String(dayDate.getDate()).padStart(2, '0')}`
    const status = monthReviewStatus.get(dateStr)
    if (status === 'completed') return 'Completed'
    if (status === 'partial') return 'Partial'
    return 'Not started'
  }

  const handlePreviousMonth = () => {
    const newMonth = subMonths(displayMonth, 1)
    onDisplayMonthChange(newMonth)
  }

  const handleNextMonth = () => {
    const newMonth = addMonths(displayMonth, 1)
    onDisplayMonthChange(newMonth)
  }

  // Parse selected date for comparison
  const [selYear, selMonth, selDay] = selectedDate.split('-').map(Number)
  const selectedDateObj = new Date(selYear, selMonth - 1, selDay)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={handlePreviousMonth}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition"
          aria-label="Previous month"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          {format(displayMonth, 'MMMM yyyy')}
        </h3>
        <button
          onClick={handleNextMonth}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition"
          aria-label="Next month"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {weekDays.map((day) => (
          <div key={day} className="text-center text-xs font-semibold text-gray-600 dark:text-gray-400 p-2">
            {day}
          </div>
        ))}
        {emptyDays.map((_, i) => (
          <div key={`empty-${i}`} className="p-2" />
        ))}
        {days.map((day) => {
          // Format as YYYY-MM-DD using local timezone
          const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
          const isSelected = isSameDay(day, selectedDateObj)
          const status = monthReviewStatus.get(dateStr)
          const isDisabled = !hasAssignments
          
          return (
            <button
              key={dateStr}
              onClick={() => {
                if (!isDisabled) {
                  onDateSelect(dateStr)
                }
              }}
              disabled={isDisabled}
              className={`p-2 rounded transition-all ${
                isDisabled
                  ? 'bg-gray-50 dark:bg-gray-900 text-gray-400 dark:text-gray-600 cursor-not-allowed'
                  : isSelected
                  ? 'bg-blue-500 text-white ring-2 ring-blue-300'
                  : status === 'completed'
                  ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 hover:bg-green-200 dark:hover:bg-green-800'
                  : status === 'partial'
                  ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 hover:bg-yellow-200 dark:hover:bg-yellow-800'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              title={isDisabled ? 'No assignments for this month' : getStatusText(day)}
            >
              <div className="text-sm font-medium">{format(day, 'd')}</div>
              {!isDisabled && status && (
                <div className={`w-2 h-2 mx-auto mt-1 rounded-full ${
                  status === 'completed' ? 'bg-green-600' : 'bg-yellow-600'
                }`} />
              )}
            </button>
          )
        })}
      </div>
      <div className="mt-4 flex gap-4 text-xs text-gray-600 dark:text-gray-400">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-green-500 rounded-full" />
          <span>Completed</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-yellow-500 rounded-full" />
          <span>Partial</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-gray-300 dark:bg-gray-600 rounded-full" />
          <span>Not started</span>
        </div>
      </div>
    </div>
  )
}

export default function DailyPage() {
  const [summary, setSummary] = useState<DailySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [slidingOutIds, setSlidingOutIds] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editHtmlContent, setEditHtmlContent] = useState('')
  const [editSource, setEditSource] = useState('')
  const [editAuthor, setEditAuthor] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [editCategories, setEditCategories] = useState<string[]>([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showCategoryInput, setShowCategoryInput] = useState(false)
  const [skipNotionSync, setSkipNotionSync] = useState(false)
  const [monthReviewStatus, setMonthReviewStatus] = useState<Map<string, 'completed' | 'partial' | 'none'>>(new Map())
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)
  const [showCompletionDialog, setShowCompletionDialog] = useState(false)
  const [hasShownCompletionDialog, setHasShownCompletionDialog] = useState(false)
  const [displayMonth, setDisplayMonth] = useState(() => {
    const now = new Date()
    return startOfMonth(now)
  })
  
  // Normalize displayMonth setter to always use start of month
  const handleDisplayMonthChange = useCallback((newMonth: Date) => {
    setDisplayMonth(startOfMonth(newMonth))
  }, [])
  const [monthsWithAssignments, setMonthsWithAssignments] = useState<Set<string>>(new Set())
  const supabase = createClient()
  const router = useRouter()

  // Offline state
  const { isOnline } = useOfflineStatus()
  const [isSyncing, setIsSyncing] = useState(false)
  const [pendingSyncCount, setPendingSyncCount] = useState(0)
  const [usingCachedData, setUsingCachedData] = useState(false)

  const editingHighlight = editingId
    ? summary?.highlights.find((sh) => sh.highlight?.id === editingId)?.highlight
    : null
  const hasUnsavedEdit =
    editingId &&
    editingHighlight &&
    (editText !== editingHighlight.text ||
      (editHtmlContent || editText) !== (editingHighlight.html_content || editingHighlight.text) ||
      (editSource || '') !== (editingHighlight.source || '') ||
      (editAuthor || '') !== (editingHighlight.author || ''))
  useUnsavedChanges(!!hasUnsavedEdit)

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

  const ensureDailySummary = useCallback(async (selectedDate: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Check if summary exists
      const { data: existing, error: checkError } = await supabase
        .from('daily_summaries')
        .select('id')
        .eq('date', selectedDate)
        .eq('user_id', user.id)
        .maybeSingle()

      if (checkError && checkError.code !== 'PGRST116') throw checkError
      if (existing) return

      // Get the current month in YYYY-MM format
      const date = new Date(selectedDate)
      const year = date.getFullYear()
      const month = date.getMonth() + 1
      const currentMonth = `${year}-${String(month).padStart(2, '0')}`
      const daysInMonth = new Date(year, month, 0).getDate()
      const dayOfMonth = date.getDate()

      // Check if assignments exist for this month
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`
      const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`
      
      const { data: monthSummaries, error: monthError } = await supabase
        .from('daily_summaries')
        .select('id, date')
        .eq('user_id', user.id)
        .gte('date', startDate)
        .lte('date', endDate)

      if (monthError) throw monthError

      // If no assignments exist for this month, create them
      if (!monthSummaries || monthSummaries.length === 0) {
        // Call the assignment API to create assignments for the entire month
        const response = await fetch('/api/daily/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year, month }),
        })

        if (!response.ok) {
          const error = await response.json()
          throw new Error(error.error || 'Failed to create assignments')
        }
      }

      // Also check and prepare next month if we're in the last week of the current month
      const daysUntilMonthEnd = daysInMonth - dayOfMonth
      if (daysUntilMonthEnd <= 7) {
        // Prepare next month's assignments
        const nextMonthDate = new Date(year, month, 1) // First day of next month
        const nextYear = nextMonthDate.getFullYear()
        const nextMonth = nextMonthDate.getMonth() + 1
        const nextMonthDays = new Date(nextYear, nextMonth, 0).getDate()
        const nextMonthStart = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
        const nextMonthEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextMonthDays).padStart(2, '0')}`

        const { data: nextMonthSummaries } = await supabase
          .from('daily_summaries')
          .select('id')
          .eq('user_id', user.id)
          .gte('date', nextMonthStart)
          .lte('date', nextMonthEnd)

        // If next month doesn't have assignments yet, create them
        if (!nextMonthSummaries || nextMonthSummaries.length === 0) {
          try {
            await fetch('/api/daily/assign', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ year: nextYear, month: nextMonth }),
            })
          } catch (error) {
            console.warn('Failed to prepare next month assignments:', error)
            // Don't block current month's summary if next month prep fails
          }
        }
      }
    } catch (error) {
      console.error('Error ensuring daily summary:', error)
    }
  }, [supabase])

  const loadDailySummary = useCallback(async (selectedDate: string) => {
    setLoading(true)
    setUsingCachedData(false)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        return
      }

      // First, ensure today's summary exists (skip when offline)
      if (navigator.onLine) {
        await ensureDailySummary(selectedDate)
      }

      // Then load it
      const { data: summaryDataRaw, error } = await supabase
        .from('daily_summaries')
        .select('*')
        .eq('date', selectedDate)
        .eq('user_id', user.id)
        .maybeSingle()

      if (error) throw error

      if (summaryDataRaw) {
        const summaryData = summaryDataRaw as { id: string; date: string; created_at: string }
        
        // Get highlights for this summary with their ratings.
        // Order: reviewed first (rating not null), then unreviewed; within each group by id for stable order
        // so returning to the page or new highlights added to the day doesn't scramble the list.
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
              ),
              highlight_links_from:highlight_links!from_highlight_id (
                id,
                to_highlight_id,
                link_text,
                to_highlight:highlights!to_highlight_id (
                  id,
                  text,
                  source,
                  author
                )
              )
            )
          `)
          .eq('daily_summary_id', summaryData.id)
          .order('rating', { ascending: false, nullsFirst: false })
          .order('id', { ascending: true })

        if (highlightsError) throw highlightsError

        const processedHighlights = (summaryHighlights || []).map((sh: any) => ({
          id: sh.id,
          daily_summary_id: summaryData.id,
          highlight_id: sh.highlight_id,
          rating: sh.rating,
          highlight: sh.highlight
            ? {
                ...sh.highlight,
                categories: sh.highlight.highlight_categories?.map((hc: any) => hc.category) || [],
                linked_highlights: sh.highlight.highlight_links_from || [],
              }
            : null,
        }))

        const summaryObj = {
          id: summaryData.id,
          date: summaryData.date,
          highlights: processedHighlights,
          created_at: summaryData.created_at,
        }

        setSummary(summaryObj)

        // Cache for offline use
        try {
          await cacheDailyData({
            date: selectedDate,
            summary: summaryObj,
            categories: categories,
            pinnedHighlightIds: Array.from(pinnedHighlightIds),
            cachedAt: Date.now(),
          })
        } catch (e) {
          console.warn('Failed to cache daily data:', e)
        }
      } else {
        setSummary(null)
      }
    } catch (error) {
      console.error('Error loading daily summary:', error)

      // If offline, try to load from cache
      if (!navigator.onLine) {
        try {
          const cached = await getCachedDailyData(selectedDate)
          if (cached) {
            setSummary(cached.summary)
            if (cached.categories) setCategories(cached.categories as any[])
            if (cached.pinnedHighlightIds) setPinnedHighlightIds(new Set(cached.pinnedHighlightIds))
            setUsingCachedData(true)
          }
        } catch (cacheError) {
          console.error('Failed to load cached data:', cacheError)
        }
      }
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureDailySummary, supabase])

  const loadMonthReviewStatus = useCallback(async (monthToLoad: Date) => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Normalize to start of month to ensure consistent behavior
      const normalizedMonth = startOfMonth(monthToLoad)
      const yearNum = normalizedMonth.getFullYear()
      const monthNum = normalizedMonth.getMonth() + 1
      const daysInMonth = new Date(yearNum, monthNum, 0).getDate()
      const startDate = `${yearNum}-${String(monthNum).padStart(2, '0')}-01`
      const endDate = `${yearNum}-${String(monthNum).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`

      // Get all daily summaries for the month
      const { data: summaries, error: summariesError } = await supabase
        .from('daily_summaries')
        .select('id, date')
        .eq('user_id', user.id)
        .gte('date', startDate)
        .lte('date', endDate)

      if (summariesError) throw summariesError

      // Get all daily_summary_highlights for these summaries (paginate to avoid Supabase 1000-row limit)
      if (summaries && summaries.length > 0) {
        const summariesData = summaries as Array<{ id: string; date: string }>
        const summaryIds = summariesData.map((s) => s.id)
        const PAGE = 1000
        let highlights: Array<{ daily_summary_id: string; rating: string | null }> = []
        let from = 0
        while (true) {
          const { data: page, error: highlightsError } = await supabase
            .from('daily_summary_highlights')
            .select('daily_summary_id, rating')
            .in('daily_summary_id', summaryIds)
            .range(from, from + PAGE - 1)
          if (highlightsError) throw highlightsError
          const list = (page || []) as Array<{ daily_summary_id: string; rating: string | null }>
          highlights = highlights.concat(list)
          if (list.length < PAGE) break
          from += PAGE
        }

        // Group highlights by summary and check completion status
        const statusMap = new Map<string, 'completed' | 'partial' | 'none'>()
        
        for (const summary of summariesData) {
          const summaryHighlights = highlights?.filter((h: any) => h.daily_summary_id === summary.id) || []
          const totalHighlights = summaryHighlights.length
          const ratedHighlights = summaryHighlights.filter((h: any) => h.rating !== null).length

          if (totalHighlights === 0) {
            statusMap.set(summary.date, 'none')
          } else if (ratedHighlights === totalHighlights) {
            statusMap.set(summary.date, 'completed')
          } else if (ratedHighlights > 0) {
            statusMap.set(summary.date, 'partial')
          } else {
            statusMap.set(summary.date, 'none')
          }
        }

        setMonthReviewStatus(statusMap)
      } else {
        setMonthReviewStatus(new Map())
      }
    } catch (error) {
      console.error('Error loading month review status:', error)
    }
  }, [supabase])

  // Load all months with assignments
  const loadMonthsWithAssignments = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Get all daily summaries to find which months have assignments
      const { data: summaries, error: summariesError } = await supabase
        .from('daily_summaries')
        .select('date')
        .eq('user_id', user.id)
        .order('date', { ascending: false })

      if (summariesError) throw summariesError

      // Extract unique months (YYYY-MM format)
      const monthsSet = new Set<string>()
      if (summaries) {
        const typedSummaries = summaries as Array<{ date: string }>
        for (const summary of typedSummaries) {
          const [year, month] = summary.date.split('-')
          monthsSet.add(`${year}-${month}`)
        }
      }

      setMonthsWithAssignments(monthsSet)
    } catch (error) {
      console.error('Error loading months with assignments:', error)
    }
  }, [supabase])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    loadDailySummary(date)
    setHasShownCompletionDialog(false)
    setShowCompletionDialog(false)
  }, [date, loadDailySummary])

  // Auto-scroll to the first unreviewed highlight when returning to a partial review
  useEffect(() => {
    if (loading || !summary || summary.highlights.length === 0) return

    const firstUnreviewed = summary.highlights.find((sh) => sh.rating === null)
    if (!firstUnreviewed?.highlight?.id) return

    // Only scroll if there are some reviewed highlights (i.e. partially done)
    const hasReviewed = summary.highlights.some((sh) => sh.rating !== null)
    if (!hasReviewed) return

    // Short delay to let DOM render the highlight cards
    const timer = setTimeout(() => {
      const el = document.getElementById(`highlight-${firstUnreviewed.highlight!.id}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [loading, summary])

  // Check if all highlights are rated
  const allHighlightsRated = useMemo(() => {
    if (!summary || summary.highlights.length === 0) return false
    return summary.highlights.every((sh) => sh.rating !== null)
  }, [summary])

  // Generate confetti pieces (only when dialog is shown)
  const confettiPieces = useMemo(() => {
    if (!showCompletionDialog) return []
    const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#f0932b', '#eb4d4b', '#6c5ce7', '#a29bfe']
    return Array.from({ length: 50 }).map((_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 2,
      color: colors[Math.floor(Math.random() * colors.length)],
    }))
  }, [showCompletionDialog])

  // Show completion dialog only when the current day is completed (summary matches selected date)
  useEffect(() => {
    if (allHighlightsRated && !hasShownCompletionDialog && summary?.date === date) {
      setShowCompletionDialog(true)
      setHasShownCompletionDialog(true)
    }
  }, [allHighlightsRated, hasShownCompletionDialog, summary?.date, date])

  useEffect(() => {
    loadMonthReviewStatus(displayMonth)
  }, [displayMonth, loadMonthReviewStatus])

  useEffect(() => {
    loadMonthsWithAssignments()
  }, [loadMonthsWithAssignments])

  // Update display month when date changes (if date is in a different month)
  // Only sync when date changes, not when displayMonth changes (to avoid conflicts with manual navigation)
  useEffect(() => {
    const [year, month] = date.split('-').map(Number)
    const dateMonth = startOfMonth(new Date(year, month - 1, 1))
    const currentDisplayMonth = startOfMonth(displayMonth)
    // Only update if the date's month is different from the displayed month
    if (!isSameMonth(dateMonth, currentDisplayMonth)) {
      setDisplayMonth(dateMonth)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]) // Only depend on date - we check displayMonth inside but don't want to re-run when it changes

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

  const handleRatingChange = async (
    summaryHighlightId: string,
    highlightId: string,
    rating: 'low' | 'med' | 'high' | null
  ) => {
    // Optimistic UI update (runs whether online or offline)
    if (summary) {
      const updatedHighlights = summary.highlights.map((sh) => {
        if (sh.id === summaryHighlightId) {
          return { ...sh, rating }
        }
        return sh
      })
      setSummary({ ...summary, highlights: updatedHighlights })
    }

    // If offline, queue the action and update local state only
    if (!isOnline) {
      try {
        await enqueueOfflineAction({
          type: 'rate-daily',
          params: {
            summaryHighlightId,
            highlightId,
            rating,
            summaryDate: summary?.date || date,
          },
        })

        // Update overlay state
        if (summary && rating !== null) {
          setSlidingOutIds((prev) => new Set(prev).add(summaryHighlightId))
          const currentIndex = summary.highlights.findIndex((sh) => sh.id === summaryHighlightId)
          const nextHighlight = summary.highlights[currentIndex + 1]
          if (nextHighlight?.highlight?.id) {
            setTimeout(() => {
              const nextElement = document.getElementById(`highlight-${nextHighlight.highlight!.id}`)
              if (nextElement) {
                nextElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
            }, 200)
          }
        } else if (rating === null) {
          setSlidingOutIds((prev) => {
            const next = new Set(prev)
            next.delete(summaryHighlightId)
            return next
          })
        }

        // Update cached data
        try {
          const cached = await getCachedDailyData(date)
          if (cached && cached.summary) {
            const updatedSummary = {
              ...cached.summary,
              highlights: cached.summary.highlights.map((sh: any) =>
                sh.id === summaryHighlightId ? { ...sh, rating } : sh
              ),
            }
            await cacheDailyData({ ...cached, summary: updatedSummary, cachedAt: Date.now() })
          }
        } catch (e) {
          console.warn('Failed to update cache:', e)
        }
      } catch (error) {
        console.error('Error queuing offline rating:', error)
        // Revert optimistic update on error
        if (summary) {
          const revertedHighlights = summary.highlights.map((sh) => {
            if (sh.id === summaryHighlightId) {
              return { ...sh, rating: null }
            }
            return sh
          })
          setSummary({ ...summary, highlights: revertedHighlights })
        }
      }
      return
    }

    try {
      // Update the rating in daily_summary_highlights
      const { error: updateError } = await (supabase
        .from('daily_summary_highlights') as any)
        .update({ rating })
        .eq('id', summaryHighlightId)

      if (updateError) throw updateError

      // Mark highlight as reviewed for the month of the summary being reviewed (not "today"),
      // so reviewing January's assignments in February records 2026-01, not 2026-02.
      if (rating !== null && summary?.date) {
        const [y, mo] = summary.date.split('-').map(Number)
        const monthYear = `${y}-${String(mo).padStart(2, '0')}`
        await (supabase
          .from('highlight_months_reviewed') as any)
          .upsert(
            { highlight_id: highlightId, month_year: monthYear },
            { onConflict: 'highlight_id,month_year' }
          )
      }

      // Recalculate average rating for the highlight (uses ALL ratings for average)
      const { data: allRatingsData, error: ratingsError } = await supabase
        .from('daily_summary_highlights')
        .select('rating')
        .eq('highlight_id', highlightId)
        .not('rating', 'is', null)

      if (ratingsError) throw ratingsError

      const allRatings = (allRatingsData || []) as Array<{ rating: string }>

      // Map text ratings to numeric values for average calculation (low=1, med=2, high=3)
      const ratingMap: Record<string, number> = { low: 1, med: 2, high: 3 }
      const ratingValues: number[] = allRatings.map((r) => ratingMap[r.rating] || 0).filter((v) => v > 0)

      const average = ratingValues.length > 0
        ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
        : 0

      // Check if this highlight was previously unarchived manually
      const { data: highlightData } = await (supabase
        .from('highlights') as any)
        .select('unarchived_at')
        .eq('id', highlightId)
        .single()

      // Count low ratings — if the highlight was manually unarchived, only count
      // low ratings from daily summaries dated AFTER the unarchive timestamp
      let lowRatingsCount = 0
      if (highlightData?.unarchived_at) {
        // Only count low ratings from summaries after the unarchive date
        const { data: recentLowRatings } = await supabase
          .from('daily_summary_highlights')
          .select('rating, daily_summary:daily_summaries!inner(date)')
          .eq('highlight_id', highlightId)
          .eq('rating', 'low')
          .gt('daily_summary.date', highlightData.unarchived_at.split('T')[0])

        lowRatingsCount = (recentLowRatings || []).length
      } else {
        // No unarchive history — count all low ratings
        lowRatingsCount = allRatings.filter((r) => r.rating === 'low').length
      }

      // If marked as 'low' twice or more (since last unarchive), archive it
      const shouldArchive = lowRatingsCount >= 2

      // Update highlight with new average rating and archived status
      await (supabase
        .from('highlights') as any)
        .update({
          average_rating: average,
          rating_count: ratingValues.length,
          ...(shouldArchive ? { archived: true } : {}),
        })
        .eq('id', highlightId)

      // Update overlay state: add overlay when rating is set, remove when cleared
      if (summary) {
        if (rating !== null) {
          setSlidingOutIds((prev) => new Set(prev).add(summaryHighlightId))
          // Find the next highlight to scroll to
          const currentIndex = summary.highlights.findIndex((sh) => sh.id === summaryHighlightId)
          const nextHighlight = summary.highlights[currentIndex + 1]
          if (nextHighlight?.highlight?.id) {
            setTimeout(() => {
              const nextElement = document.getElementById(`highlight-${nextHighlight.highlight!.id}`)
              if (nextElement) {
                nextElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
            }, 200)
          }
        } else {
          // Clearing rating: ungray the highlight by removing from slidingOutIds
          setSlidingOutIds((prev) => {
            const next = new Set(prev)
            next.delete(summaryHighlightId)
            return next
          })
        }
      }

      // Reload month review status to update calendar
      const [year, month] = date.split('-').map(Number)
      const dateMonth = new Date(year, month - 1, 1)
      await loadMonthReviewStatus(dateMonth)
      await loadMonthsWithAssignments()
    } catch (error) {
      console.error('Error updating rating:', error)
      // Revert optimistic update on error
      await loadDailySummary(date)
    }
  }

  const handleStartEdit = (highlight: any) => {
    setEditingId(highlight.id)
    setEditText(highlight.text)
    setEditHtmlContent(highlight.html_content || highlight.text)
    setEditSource(highlight.source || '')
    setEditAuthor(highlight.author || '')
    setEditCategories(highlight.categories?.map((c: any) => c.id) || [])
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditText('')
    setEditHtmlContent('')
    setEditSource('')
    setEditAuthor('')
    setEditCategories([])
    setShowCategoryInput(false)
    setNewCategoryName('')
  }

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return
    try {
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
      setEditCategories([...editCategories, data.id])
      setNewCategoryName('')
      setShowCategoryInput(false)
    } catch (error) {
      console.error('Error creating category:', error)
      alert('Failed to create category. It may already exist.')
    }
  }

  const handleSaveEdit = async (highlightId: string) => {
    if (!editText.trim()) return

    try {
      // Get original highlight data before updating (needed for sync queue)
      const originalHighlight = summary?.highlights.find(
        (sh) => sh.highlight?.id === highlightId
      )?.highlight
      const originalText = originalHighlight?.text || null
      const originalHtmlContent = originalHighlight?.html_content || null

      // Check for duplicate highlights (excluding current one)
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: existingHighlights, error: checkError } = await (supabase
          .from('highlights') as any)
          .select('id, text, html_content')
          .eq('user_id', user.id)
          .neq('id', highlightId)

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
        .eq('id', highlightId)

      if (updateError) throw updateError

      // Update categories
      // First, remove existing categories
      await (supabase
        .from('highlight_categories') as any)
        .delete()
        .eq('highlight_id', highlightId)

      // Then add new ones
      if (editCategories.length > 0) {
        const categoryLinks = editCategories.map((catId) => ({
          highlight_id: highlightId,
          category_id: catId,
        }))
        await (supabase.from('highlight_categories') as any).insert(categoryLinks)
      }

      // Add to Notion sync queue only if text/HTML actually changed (skip for category/source/author-only edits)
      const textChanged = editText.trim() !== (originalText || '') ||
        (editHtmlContent.trim() || null) !== (originalHtmlContent || null)
      if (!skipNotionSync && textChanged) {
        await addToSyncQueue(
          highlightId,
          'update',
          editText.trim(),
          editHtmlContent.trim() || null,
          originalText,
          originalHtmlContent
        )
      }

      // Reload summary to reflect changes
      await loadDailySummary(date)
      const [year, month] = date.split('-').map(Number)
      const dateMonth = new Date(year, month - 1, 1)
      await loadMonthReviewStatus(dateMonth)
      handleCancelEdit()
    } catch (error) {
      console.error('Error updating highlight:', error)
      alert('Failed to update highlight. Please try again.')
    }
  }

  const handleDelete = async (highlightId: string) => {
    if (!confirm('Are you sure you want to delete this highlight?')) return

    try {
      // Get highlight data before deleting (needed for sync queue)
      const highlightToDelete = summary?.highlights.find(
        (sh) => sh.highlight?.id === highlightId
      )?.highlight
      const text = highlightToDelete?.text || null
      const htmlContent = highlightToDelete?.html_content || null

      // Add to Notion sync queue BEFORE deleting (if configured)
      await addToSyncQueue(
        highlightId,
        'delete',
        text,
        htmlContent
      )

      // Delete from database (CASCADE removes it from daily_summary_highlights, so it won't appear in any day's review)
      const { error } = await (supabase
        .from('highlights') as any)
        .delete()
        .eq('id', highlightId)

      if (error) throw error

      // Redistribute remaining highlights across future days so next month's daily reviews stay consistent
      await fetch('/api/daily/redistribute', { method: 'POST' })

      // Reload summary to reflect changes
      await loadDailySummary(date)
      const [year, month] = date.split('-').map(Number)
      const dateMonth = new Date(year, month - 1, 1)
      await loadMonthReviewStatus(dateMonth)
      await loadMonthsWithAssignments()
    } catch (error) {
      console.error('Error deleting highlight:', error)
      alert('Failed to delete highlight. Please try again.')
    }
  }

  const handleArchive = async (highlightId: string, archive: boolean) => {
    if (archive && !confirm('Are you sure you want to archive this highlight?')) return
    try {
      const { error } = await (supabase
        .from('highlights') as any)
        .update({ archived: archive })
        .eq('id', highlightId)

      if (error) throw error

      // Reload summary to reflect changes
      await loadDailySummary(date)
      const [year, month] = date.split('-').map(Number)
      const dateMonth = new Date(year, month - 1, 1)
      await loadMonthReviewStatus(dateMonth)
      await loadMonthsWithAssignments()
    } catch (error) {
      console.error('Error archiving highlight:', error)
      alert('Failed to archive highlight. Please try again.')
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

  // ─── Offline Sync ─────────────────────────────────────────

  // When coming back online, replay queued actions
  useEffect(() => {
    if (!isOnline) return

    const syncOfflineActions = async () => {
      const actions = await getPendingActions()
      // Only process daily-type actions here
      const dailyActions = actions.filter((a) => a.type === 'rate-daily')
      if (dailyActions.length === 0) return

      setIsSyncing(true)
      setPendingSyncCount(dailyActions.length)

      for (const action of dailyActions) {
        try {
          if (action.type === 'rate-daily') {
            const { summaryHighlightId, highlightId, rating, summaryDate } = action.params

            await (supabase.from('daily_summary_highlights') as any)
              .update({ rating })
              .eq('id', summaryHighlightId)

            if (rating !== null && summaryDate) {
              const [y, mo] = summaryDate.split('-').map(Number)
              const monthYear = `${y}-${String(mo).padStart(2, '0')}`
              ;(supabase.from('highlight_months_reviewed') as any)
                .upsert(
                  { highlight_id: highlightId, month_year: monthYear },
                  { onConflict: 'highlight_id,month_year' }
                )
            }

            const { data: allRatingsData } = await supabase
              .from('daily_summary_highlights')
              .select('rating')
              .eq('highlight_id', highlightId)
              .not('rating', 'is', null)

            const allRatings = (allRatingsData || []) as Array<{ rating: string }>
            const ratingMap: Record<string, number> = { low: 1, med: 2, high: 3 }
            const ratingValues = allRatings.map((r) => ratingMap[r.rating] || 0).filter((v) => v > 0)
            const average = ratingValues.length > 0
              ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
              : 0

            const { data: highlightData } = await (supabase.from('highlights') as any)
              .select('unarchived_at')
              .eq('id', highlightId)
              .single()

            let lowRatingsCount = 0
            if (highlightData?.unarchived_at) {
              const { data: recentLowRatings } = await supabase
                .from('daily_summary_highlights')
                .select('rating, daily_summary:daily_summaries!inner(date)')
                .eq('highlight_id', highlightId)
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
              .eq('id', highlightId)
          }

          await removeAction(action.id!)
          setPendingSyncCount((prev) => prev - 1)
        } catch (error) {
          console.error('Error syncing offline action:', error)
          break
        }
      }

      setIsSyncing(false)
      setPendingSyncCount(0)

      // Reload fresh data after sync
      loadDailySummary(date)
      const [year, month] = date.split('-').map(Number)
      const dateMonth = new Date(year, month - 1, 1)
      loadMonthReviewStatus(dateMonth)
      loadMonthsWithAssignments()
    }

    syncOfflineActions()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      {/* Offline Banner */}
      <OfflineBanner isOnline={isOnline} isSyncing={isSyncing} pendingCount={pendingSyncCount} />

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex justify-between items-center mb-4 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white">
              Daily Summary
            </h1>
            <Link
              href="/"
              className="flex items-center gap-2 px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition text-sm sm:text-base"
            >
              <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              <span className="hidden sm:inline">Home</span>
            </Link>
          </div>

          <div className="mb-6">
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg">
              <CalendarView
                key={format(displayMonth, 'yyyy-MM')} // Force re-render when month changes
                selectedDate={date}
                onDateSelect={setDate}
                monthReviewStatus={monthReviewStatus}
                displayMonth={displayMonth}
                onDisplayMonthChange={handleDisplayMonthChange}
                monthsWithAssignments={monthsWithAssignments}
              />
            </div>
          </div>

          {summary ? (
            <div>
              <div className="mb-4">
                <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
                  {(() => {
                    // Parse date string (YYYY-MM-DD) as local date to avoid timezone offset
                    const [year, month, day] = summary.date.split('-').map(Number)
                    const localDate = new Date(year, month - 1, day)
                    return format(localDate, 'EEEE, MMMM d, yyyy')
                  })()}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {summary.highlights.length} {summary.highlights.length === 1 ? 'highlight' : 'highlights'}
                </p>
              </div>
              {summary.highlights.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-lg text-center text-gray-500 dark:text-gray-400">
                  No highlights to resurface for this date.
                </div>
              ) : (
                <div className="space-y-4">
                  {summary.highlights.map((summaryHighlight: DailySummaryHighlight) => {
                    const highlight = summaryHighlight.highlight
                    if (!highlight) return null

                    return (
                      <div
                        key={summaryHighlight.id}
                        id={`highlight-${highlight.id}`}
                        className={`bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg transition-all duration-300 ease-in-out relative ${
                          (slidingOutIds.has(summaryHighlight.id) || summaryHighlight.rating !== null) ? 'rated-overlay' : ''
                        }`}
                        style={{
                          animation: slidingOutIds.has(summaryHighlight.id) ? undefined : 'slideIn 0.3s ease-out',
                        }}
                      >
                        {(slidingOutIds.has(summaryHighlight.id) || summaryHighlight.rating !== null) && (
                          <div className="absolute inset-0 bg-gray-500/30 dark:bg-gray-900/50 rounded-lg z-10 pointer-events-none transition-opacity duration-300" />
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
                            <div className="grid md:grid-cols-2 gap-4">
                              <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                  Source (optional)
                                </label>
                                <input
                                  type="text"
                                  value={editSource}
                                  onChange={(e) => setEditSource(e.target.value)}
                                  className="input-boxed-elegant"
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
                                  className="input-boxed-elegant"
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
                                {!showCategoryInput ? (
                                  <button
                                    type="button"
                                    onClick={() => setShowCategoryInput(true)}
                                    className="px-3 py-1 rounded-full text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition border border-dashed border-gray-300 dark:border-gray-600"
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
                                      className="px-3 py-1 bg-blue-600 text-white rounded-full text-sm hover:bg-blue-700 transition"
                                    >
                                      Add
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setShowCategoryInput(false)
                                        setNewCategoryName('')
                                      }}
                                      className="px-3 py-1 bg-gray-200 dark:bg-gray-700 rounded-full text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                )}
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
                                onClick={() => handleSaveEdit(highlight.id)}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                              >
                                Save
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
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
                        {(highlight.source || highlight.author) && (
                          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                            {highlight.author && <span>{highlight.author}</span>}
                            {highlight.author && highlight.source && <span> • </span>}
                            {highlight.source && <span>{highlight.source}</span>}
                          </p>
                        )}
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
                          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                            <span className="text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">Rate:</span>
                            <div className="flex gap-1.5 sm:gap-2 items-center flex-wrap">
                              {(['low', 'med', 'high'] as const).map((ratingValue) => {
                                const isActive = summaryHighlight.rating === ratingValue
                                const getColorClasses = (val: string) => {
                                  if (val === 'low') {
                                    return isActive
                                      ? 'bg-red-500 text-white shadow-red-500/50'
                                      : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/50 border-2 border-red-300 dark:border-red-700'
                                  } else if (val === 'med') {
                                    return isActive
                                      ? 'bg-yellow-500 text-white shadow-yellow-500/50'
                                      : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-900/50 border-2 border-yellow-300 dark:border-yellow-700'
                                  } else {
                                    return isActive
                                      ? 'bg-green-500 text-white shadow-green-500/50'
                                      : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50 border-2 border-green-300 dark:border-green-700'
                                  }
                                }
                                const label = ratingValue === 'low' ? 'Low' : ratingValue === 'med' ? 'Med' : 'High'
                                return (
                                  <button
                                    key={ratingValue}
                                    onClick={() => handleRatingChange(summaryHighlight.id, highlight.id, ratingValue)}
                                    className={`px-3 sm:px-5 py-1.5 sm:py-2 text-sm sm:text-base font-semibold rounded-lg transition-all transform hover:scale-105 active:scale-95 shadow-md ${getColorClasses(ratingValue)}`}
                                  >
                                    {label}
                                  </button>
                                )
                              })}
                              {summaryHighlight.rating && (
                                <button
                                  onClick={() => handleRatingChange(summaryHighlight.id, highlight.id, null)}
                                  className="px-2.5 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:ml-auto">
                            {highlight.average_rating !== undefined && highlight.average_rating > 0 && (
                              <div className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">
                                Avg: {highlight.average_rating.toFixed(1)}/3 ({highlight.rating_count} ratings)
                              </div>
                            )}
                            {editingId !== highlight.id && (
                              <div className="flex gap-1.5 sm:gap-2 flex-wrap">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handlePin(highlight.id)
                                  }}
                                  disabled={!isOnline}
                                  className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded transition disabled:opacity-40 disabled:cursor-not-allowed ${
                                    pinnedHighlightIds.has(highlight.id)
                                      ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-800'
                                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                                  }`}
                                  title={!isOnline ? 'Pinning is not available offline' : pinnedHighlightIds.has(highlight.id) ? 'Unpin' : 'Pin'}
                                >
                                  {pinnedHighlightIds.has(highlight.id) ? (
                                    <PinOff className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                                  ) : (
                                    <Pin className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                                  )}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleStartEdit(highlight)
                                  }}
                                  disabled={!isOnline}
                                  className="px-2 sm:px-3 py-1 text-xs sm:text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition disabled:opacity-40 disabled:cursor-not-allowed"
                                  title={!isOnline ? 'Editing is not available offline' : undefined}
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleArchive(highlight.id, !highlight.archived)
                                  }}
                                  disabled={!isOnline}
                                  className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded transition disabled:opacity-40 disabled:cursor-not-allowed ${
                                    highlight.archived
                                      ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-800'
                                      : 'bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-800'
                                  }`}
                                  title={!isOnline ? 'Archiving is not available offline' : undefined}
                                >
                                  {highlight.archived ? 'Unarchive' : 'Archive'}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDelete(highlight.id)
                                  }}
                                  disabled={!isOnline}
                                  className="px-2 sm:px-3 py-1 text-xs sm:text-sm bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-800 transition disabled:opacity-40 disabled:cursor-not-allowed"
                                  title={!isOnline ? 'Deleting is not available offline' : undefined}
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-lg text-center text-gray-500 dark:text-gray-400">
              No summary available for this date.
            </div>
          )}
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

      {/* Completion Dialog with Confetti */}
      {showCompletionDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowCompletionDialog(false)}
        >
          {/* Confetti Container */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {confettiPieces.map((piece) => (
              <div
                key={piece.id}
                className="confetti"
                style={{
                  left: `${piece.left}%`,
                  animationDelay: `${piece.delay}s`,
                  backgroundColor: piece.color,
                }}
              />
            ))}
          </div>

          {/* Dialog */}
          <div
            className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 transform transition-all"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center">
              <div className="text-6xl mb-4">🎉</div>
              <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
                Review Complete!
              </h2>
              <p className="text-gray-600 dark:text-gray-300 mb-6">
                Great job reviewing all your highlights for today!
              </p>
              <button
                onClick={() => router.push('/')}
                className="w-full px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-semibold text-lg"
              >
                Go to Home
              </button>
              <button
                onClick={() => setShowCompletionDialog(false)}
                className="mt-3 w-full px-6 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition text-sm"
              >
                Continue Reviewing
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
