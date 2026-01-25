'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { DailySummary, DailySummaryHighlight } from '@/types/database'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isSameMonth, isSameDay, addMonths, subMonths } from 'date-fns'
import RichTextEditor from '@/components/RichTextEditor'
import PinDialog from '@/components/PinDialog'
import { Pin, PinOff } from 'lucide-react'

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
  const monthKey = format(displayMonth, 'yyyy-MM')
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
    onDisplayMonthChange(subMonths(displayMonth, 1))
  }

  const handleNextMonth = () => {
    onDisplayMonthChange(addMonths(displayMonth, 1))
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
  const [monthReviewStatus, setMonthReviewStatus] = useState<Map<string, 'completed' | 'partial' | 'none'>>(new Map())
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)
  const [showCompletionDialog, setShowCompletionDialog] = useState(false)
  const [hasShownCompletionDialog, setHasShownCompletionDialog] = useState(false)
  const [displayMonth, setDisplayMonth] = useState(() => {
    const [year, month] = format(new Date(), 'yyyy-MM-dd').split('-').map(Number)
    return new Date(year, month - 1, 1)
  })
  const [monthsWithAssignments, setMonthsWithAssignments] = useState<Set<string>>(new Set())
  const supabase = createClient()
  const router = useRouter()

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
        return // Silently skip if Notion is not configured
      }

      const queueItem: any = {
        user_id: user.id,
        highlight_id: operationType === 'delete' ? null : highlightId,
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
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        return
      }

      // First, ensure today's summary exists
      await ensureDailySummary(selectedDate)

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
        
        // Get highlights for this summary with their ratings
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

        setSummary({
          id: summaryData.id,
          date: summaryData.date,
          highlights: processedHighlights,
          created_at: summaryData.created_at,
        })
      } else {
        setSummary(null)
      }
    } catch (error) {
      console.error('Error loading daily summary:', error)
    } finally {
      setLoading(false)
    }
  }, [ensureDailySummary, supabase])

  const loadMonthReviewStatus = useCallback(async (monthToLoad: Date) => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const yearNum = monthToLoad.getFullYear()
      const monthNum = monthToLoad.getMonth() + 1
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

      // Get all daily_summary_highlights for these summaries
      if (summaries && summaries.length > 0) {
        const summariesData = summaries as Array<{ id: string; date: string }>
        const summaryIds = summariesData.map((s) => s.id)
        const { data: highlights, error: highlightsError } = await supabase
          .from('daily_summary_highlights')
          .select('daily_summary_id, rating')
          .in('daily_summary_id', summaryIds)

        if (highlightsError) throw highlightsError

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
        for (const summary of summaries) {
          const [year, month] = summary.date.split('-')
          monthsSet.add(`${year}-${month}`)
        }
      }

      setMonthsWithAssignments(monthsSet)
    } catch (error) {
      console.error('Error loading months with assignments:', error)
    }
  }, [supabase])

  useEffect(() => {
    loadDailySummary(date)
    setHasShownCompletionDialog(false)
    setShowCompletionDialog(false)
  }, [date, loadDailySummary])

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

  // Show completion dialog when all highlights are rated
  useEffect(() => {
    if (allHighlightsRated && !hasShownCompletionDialog) {
      setShowCompletionDialog(true)
      setHasShownCompletionDialog(true)
    }
  }, [allHighlightsRated, hasShownCompletionDialog])

  useEffect(() => {
    loadMonthReviewStatus(displayMonth)
  }, [displayMonth, loadMonthReviewStatus])

  useEffect(() => {
    loadMonthsWithAssignments()
  }, [loadMonthsWithAssignments])

  // Update display month when date changes (if date is in a different month)
  useEffect(() => {
    const [year, month] = date.split('-').map(Number)
    const dateMonth = new Date(year, month - 1, 1)
    if (!isSameMonth(dateMonth, displayMonth)) {
      setDisplayMonth(dateMonth)
    }
  }, [date, displayMonth])

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
    rating: 1 | 2 | 3 | 4 | 5 | null
  ) => {
    try {
      // Optimistically update the UI first
      if (summary) {
        const updatedHighlights = summary.highlights.map((sh) => {
          if (sh.id === summaryHighlightId) {
            return { ...sh, rating }
          }
          return sh
        })
        setSummary({ ...summary, highlights: updatedHighlights })
      }

      // Update the rating in daily_summary_highlights
      const { error: updateError } = await (supabase
        .from('daily_summary_highlights') as any)
        .update({ rating })
        .eq('id', summaryHighlightId)

      if (updateError) throw updateError

      // Recalculate average rating for the highlight
      const { data: allRatingsData, error: ratingsError } = await supabase
        .from('daily_summary_highlights')
        .select('rating')
        .eq('highlight_id', highlightId)
        .not('rating', 'is', null)

      if (ratingsError) throw ratingsError

      const allRatings = (allRatingsData || []) as Array<{ rating: number }>

      // Calculate average (ratings are now 1-5)
      const ratingValues: number[] = allRatings.map((r) => r.rating)

      const average = ratingValues.length > 0
        ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
        : 0

      // Count how many times this highlight has been marked as 1 (low)
      const lowRatingsCount = (allRatings || []).filter((r) => r.rating === 1).length

      // If marked as 1 (low) twice or more, archive it
      const shouldArchive = lowRatingsCount >= 2

      // Update highlight with new average rating and archived status
      await (supabase
        .from('highlights') as any)
        .update({
          average_rating: average,
          rating_count: ratingValues.length,
          archived: shouldArchive,
        })
        .eq('id', highlightId)

      // Mark highlight as reviewed for this month ONLY if a rating was given
      if (rating !== null) {
        // Get current month in YYYY-MM format
        const now = new Date()
        const year = now.getFullYear()
        const month = now.getMonth() + 1
        const monthYear = `${year}-${String(month).padStart(2, '0')}`

        // Upsert to mark this highlight as reviewed for this month
        await (supabase
          .from('highlight_months_reviewed') as any)
          .upsert(
            {
              highlight_id: highlightId,
              month_year: monthYear,
            },
            { onConflict: 'highlight_id,month_year' }
          )
      }

      // Add overlay to rated highlight and scroll to next one
      if (summary && rating !== null) {
        // Mark this highlight as rated (for overlay)
        setSlidingOutIds((prev) => new Set(prev).add(summaryHighlightId))
        
        // Find the next highlight to scroll to
        const currentIndex = summary.highlights.findIndex((sh) => sh.id === summaryHighlightId)
        const nextHighlight = summary.highlights[currentIndex + 1]
        
        if (nextHighlight?.highlight?.id) {
          // Scroll to next highlight after a brief delay
          setTimeout(() => {
            const nextElement = document.getElementById(`highlight-${nextHighlight.highlight!.id}`)
            if (nextElement) {
              nextElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          }, 200)
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
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditText('')
    setEditHtmlContent('')
    setEditSource('')
    setEditAuthor('')
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

      // Add to Notion sync queue (if configured)
      await addToSyncQueue(
        highlightId,
        'update',
        editText.trim(),
        editHtmlContent.trim() || null,
        originalText,
        originalHtmlContent
      )

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

      // Delete from database
      const { error } = await (supabase
        .from('highlights') as any)
        .delete()
        .eq('id', highlightId)

      if (error) throw error

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
                selectedDate={date}
                onDateSelect={setDate}
                monthReviewStatus={monthReviewStatus}
                displayMonth={displayMonth}
                onDisplayMonthChange={setDisplayMonth}
                monthsWithAssignments={monthsWithAssignments}
              />
            </div>
          </div>

          {summary ? (
            <div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
                {(() => {
                  // Parse date string (YYYY-MM-DD) as local date to avoid timezone offset
                  const [year, month, day] = summary.date.split('-').map(Number)
                  const localDate = new Date(year, month - 1, day)
                  return format(localDate, 'EEEE, MMMM d, yyyy')
                })()}
              </h2>
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
                            <span className="text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">Rate (1-5):</span>
                            <div className="flex gap-1.5 sm:gap-2 items-center flex-wrap">
                              {[1, 2, 3, 4, 5].map((ratingValue) => {
                                const isActive = summaryHighlight.rating === ratingValue
                                const getColorClasses = (val: number) => {
                                  if (val === 1) {
                                    return isActive
                                      ? 'bg-red-500 text-white shadow-red-500/50'
                                      : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/50 border-2 border-red-300 dark:border-red-700'
                                  } else if (val === 2) {
                                    return isActive
                                      ? 'bg-orange-500 text-white shadow-orange-500/50'
                                      : 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-900/50 border-2 border-orange-300 dark:border-orange-700'
                                  } else if (val === 3) {
                                    return isActive
                                      ? 'bg-yellow-500 text-white shadow-yellow-500/50'
                                      : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-900/50 border-2 border-yellow-300 dark:border-yellow-700'
                                  } else if (val === 4) {
                                    return isActive
                                      ? 'bg-lime-500 text-white shadow-lime-500/50'
                                      : 'bg-lime-100 dark:bg-lime-900/30 text-lime-700 dark:text-lime-300 hover:bg-lime-200 dark:hover:bg-lime-900/50 border-2 border-lime-300 dark:border-lime-700'
                                  } else {
                                    return isActive
                                      ? 'bg-green-500 text-white shadow-green-500/50'
                                      : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50 border-2 border-green-300 dark:border-green-700'
                                  }
                                }
                                return (
                                  <button
                                    key={ratingValue}
                                    onClick={() => handleRatingChange(summaryHighlight.id, highlight.id, ratingValue as 1 | 2 | 3 | 4 | 5)}
                                    className={`px-2.5 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base font-semibold rounded-lg transition-all transform hover:scale-105 active:scale-95 shadow-md ${getColorClasses(ratingValue)}`}
                                    title={ratingValue === 1 ? 'Low' : ratingValue === 3 ? 'Med' : ratingValue === 5 ? 'High' : ''}
                                  >
                                    {ratingValue}
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
                                Avg: {highlight.average_rating.toFixed(1)}/5 ({highlight.rating_count} ratings)
                              </div>
                            )}
                            {editingId !== highlight.id && (
                              <div className="flex gap-1.5 sm:gap-2 flex-wrap">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handlePin(highlight.id)
                                  }}
                                  className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded transition ${
                                    pinnedHighlightIds.has(highlight.id)
                                      ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-800'
                                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                                  }`}
                                  title={pinnedHighlightIds.has(highlight.id) ? 'Unpin' : 'Pin'}
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
                                  className="px-2 sm:px-3 py-1 text-xs sm:text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleArchive(highlight.id, !highlight.archived)
                                  }}
                                  className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded transition ${
                                    highlight.archived
                                      ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-800'
                                      : 'bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-800'
                                  }`}
                                >
                                  {highlight.archived ? 'Unarchive' : 'Archive'}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDelete(highlight.id)
                                  }}
                                  className="px-2 sm:px-3 py-1 text-xs sm:text-sm bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-800 transition"
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
