'use client'

import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Pin, PinOff, ArrowRight, Home, CalendarDays } from 'lucide-react'
import { parseIntoParagraphs, groupParagraphsByDividers, ParagraphBlock } from '@/lib/splitHighlightText'
import { renderHighlightHtml } from '@/lib/renderHighlightHtml'
import RichTextEditor from '@/components/RichTextEditor'
import PinDialog from '@/components/PinDialog'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import { removeFromFutureMonths } from '@/lib/removeFromFutureMonths'
import { callRedistribute } from '@/lib/redistribute'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { isEffectivelyOffline } from '@/hooks/useManualOffline'
import { reconcileAheadOrder, readAheadOrder, writeAheadOrder } from '@/lib/aheadOrder'
import { useOfflineSyncState } from '@/hooks/useOfflineSyncState'
import OfflineBanner from '@/components/OfflineBanner'
import {
  cacheReviewData,
  getCachedReviewData,
  enqueueOfflineAction,
} from '@/lib/offlineStore'

interface ReviewHighlight {
  id: string
  daily_summary_id: string
  highlight_id: string
  rating: 'low' | 'med' | 'high' | null
  date: string
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
    <>
      <Suspense fallback={
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-6">
        <div className="text-xl text-gray-600 dark:text-gray-300">Loading...</div>
        <Link href="/review/lite" className="text-sm text-blue-600 dark:text-blue-400 underline">
          Slow connection? Switch to text-only →
        </Link>
      </div>
    }>
      <ReviewPageContent />
      </Suspense>
    </>
  )
}

function ReviewPageContent() {
  const [highlights, setHighlights] = useState<ReviewHighlight[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [ratingInProgress, setRatingInProgress] = useState(false)
  const autoRateProcessed = useRef(false)
  const highlightContentRef = useRef<HTMLDivElement | null>(null)
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

  // Split state
  const [splitMode, setSplitMode] = useState(false)
  const [splitParagraphs, setSplitParagraphs] = useState<ParagraphBlock[]>([])
  const [splitPoints, setSplitPoints] = useState<Set<number>>(new Set())
  const [splittingInProgress, setSplittingInProgress] = useState(false)

  // Pin state
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)

  // Offline state. Draining is owned by the global <OfflineSync>; we just read
  // its progress for the banner.
  const { isOnline } = useOfflineStatus()
  const { isSyncing, pendingCount: pendingSyncCount } = useOfflineSyncState()
  const [usingCachedData, setUsingCachedData] = useState(false)

  // Inline-bold state: floating "B" button shown above any text selection
  // inside the highlight content. Lets users bold/unbold without entering edit mode.
  const [boldButtonPos, setBoldButtonPos] = useState<{ top: number; left: number } | null>(null)
  // Per-highlight undo/redo stacks holding prior html_content snapshots.
  const undoStacksRef = useRef<Map<string, string[]>>(new Map())
  const redoStacksRef = useRef<Map<string, string[]>>(new Map())
  // Bumps to force re-render of undo/redo affordances when stacks change.
  const [, setHistoryVersion] = useState(0)

  // Direction of the last highlight change. Drives the slide-in animation on
  // the highlight card: 'next' slides in from the right, 'prev' from the left.
  const [navDirection, setNavDirection] = useState<'next' | 'prev'>('next')

  // Navigation dots visibility (persisted across reloads)
  const [showDots, setShowDots] = useState(true)
  useEffect(() => {
    const stored = localStorage.getItem('review-show-dots')
    if (stored !== null) setShowDots(stored === 'true')
  }, [])
  useEffect(() => {
    localStorage.setItem('review-show-dots', String(showDots))
  }, [showDots])

  const today = format(new Date(), 'yyyy-MM-dd')

  // "Review ahead" mode (?ahead=1): in addition to today + overdue catch-up,
  // pull unrated highlights from the remaining days of the month, round-robin
  // across days, so the user can get ahead instead of stopping at today.
  const aheadMode = searchParams.get('ahead') === '1'

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

  // Patch the cached review data so changes made offline survive a reload.
  const updateCache = async (
    patch: (cached: {
      highlights: any[]
      categories: any[]
      pinnedHighlightIds: string[]
    }) => Partial<{
      highlights: any[]
      categories: any[]
      pinnedHighlightIds: string[]
    }>
  ) => {
    try {
      const cached = await getCachedReviewData()
      if (!cached) return
      const next = patch({
        highlights: cached.highlights || [],
        categories: cached.categories || [],
        pinnedHighlightIds: cached.pinnedHighlightIds || [],
      })
      await cacheReviewData({
        highlights: next.highlights ?? cached.highlights,
        categories: next.categories ?? cached.categories,
        pinnedHighlightIds: next.pinnedHighlightIds ?? cached.pinnedHighlightIds,
        cachedAt: Date.now(),
      })
    } catch (e) {
      console.warn('Failed to update offline cache:', e)
    }
  }

  const loadHighlights = useCallback(async () => {
    setLoading(true)
    setUsingCachedData(false)

    // Offline (manual switch OR a genuinely-cut connection): serve the IndexedDB
    // cache and skip the network entirely. Pressing the manual switch is treated
    // exactly like a real disconnect. Two reasons to short-circuit rather than
    // hit the network:
    //   • Manual offline usually still has a (weak) connection, so a network
    //     query would succeed and return server truth — silently reverting
    //     ratings that are queued but not yet drained.
    //   • For a real cut it avoids a doomed network round-trip (and its timeout)
    //     before falling back to the same cache.
    // The cache is patched on every offline rating, so a pull-to-refresh while
    // offline preserves them either way.
    if (isEffectivelyOffline()) {
      try {
        const cached = await getCachedReviewData()
        if (cached) {
          setHighlights(cached.highlights)
          setCategories(cached.categories || [])
          setPinnedHighlightIds(new Set(cached.pinnedHighlightIds || []))
          setUsingCachedData(true)
          const firstUnrated = cached.highlights.findIndex((h: any) => h.rating === null)
          setCurrentIndex(firstUnrated >= 0 ? firstUnrated : 0)
          setLoading(false)
          return
        }
        // No cache yet (first visit while offline) — fall through to the network
        // attempt below, which will gracefully degrade to the cache fallback.
      } catch (e) {
        console.warn('Failed to load cached review data (offline):', e)
      }
    }

    try {
      // getSession reads from local cookie — no network call needed
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) {
        setLoading(false)
        return
      }

      // Categories + pins in parallel. Highlights are fetched separately below
      // because they must be paginated (see note).
      const [catResult, pinResult] = await Promise.all([
        supabase
          .from('categories')
          .select('id, name')
          .eq('user_id', user.id)
          .order('name'),
        (supabase.from('pinned_highlights') as any)
          .select('highlight_id')
          .eq('user_id', user.id),
      ])

      setCategories(catResult.data || [])
      const pinIds = (pinResult.data || []).map((p: any) => p.highlight_id)
      setPinnedHighlightIds(new Set(pinIds))

      // Paginate to avoid Supabase's 1000-row cap. Without this, a month with
      // more than 1000 daily_summary_highlights is silently truncated — and
      // because rows are ordered by rating/id (not date), today's highlights
      // get scattered across the cutoff, undercounting them on the all-done page.
      // In ahead mode, extend the upper bound from "today" to the last day of
      // the month so the remaining days of the month are pulled in too.
      const [ty, tm] = today.split('-').map(Number)
      const lastDayOfMonth = new Date(ty, tm, 0).getDate()
      const endOfMonth = `${today.substring(0, 8)}${String(lastDayOfMonth).padStart(2, '0')}`
      const upperDate = aheadMode ? endOfMonth : today

      const PAGE = 1000
      const fetchHighlightsPage = (from: number) =>
        supabase
          .from('daily_summary_highlights')
          .select(`
            id,
            highlight_id,
            rating,
            daily_summaries!inner(id, date),
            highlight:highlights!inner (
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
          .gte('daily_summaries.date', `${today.substring(0, 8)}01`)
          .lte('daily_summaries.date', upperDate)
          .eq('daily_summaries.user_id', user.id)
          .eq('highlight.archived', false)
          .order('rating', { ascending: false, nullsFirst: true })
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)

      let hlData: any[] = []
      let from = 0
      while (true) {
        const { data: page, error: pageError } = await fetchHighlightsPage(from)
        if (pageError) throw pageError
        const list = page || []
        hlData = hlData.concat(list)
        if (list.length < PAGE) break
        from += PAGE
      }

      if (hlData.length === 0) {
        setHighlights([])
        setLoading(false)
        return
      }

      const allRows: ReviewHighlight[] = hlData.map((sh: any) => ({
        id: sh.id,
        daily_summary_id: sh.daily_summaries?.id || '',
        highlight_id: sh.highlight_id,
        rating: sh.rating,
        date: sh.daily_summaries?.date || '',
        highlight: sh.highlight
          ? {
              ...sh.highlight,
              categories: sh.highlight.highlight_categories?.map((hc: any) => hc.category) || [],
            }
          : null,
      }))

      // Today's highlights: keep both rated + unrated, sort by text length
      const todayRows = allRows
        .filter((h) => h.date === today)
        .sort((a, b) => {
          const aLen = a.highlight?.text?.length || 0
          const bLen = b.highlight?.text?.length || 0
          return aLen - bLen
        })

      // Catch-up: only unrated from earlier days, oldest first then shortest
      const catchUpRows = allRows
        .filter((h) => h.date < today && h.rating === null)
        .sort((a, b) => {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1
          const aLen = a.highlight?.text?.length || 0
          const bLen = b.highlight?.text?.length || 0
          return aLen - bLen
        })

      // Ahead: highlights from the remaining days of the month, pulled
      // round-robin — one (shortest) per future day in date order, then loop —
      // so the user gets a spread across the rest of the month rather than
      // finishing one day at a time. Only populated in ahead mode.
      //
      // The order is FROZEN: computed round-robin once, then persisted per
      // user+month and reconciled on every later load (survivors stay put, gone
      // rows drop out, new rows append). Recomputing from scratch each load —
      // the old behavior — let an auto-archive of a just-rated highlight re-pack
      // the dense round-robin and pull a later highlight ahead of the resume
      // point ("a couple of dots jumped earlier"). Freezing makes each row's
      // position independent of what was removed, so firstUnrated below can
      // never move backwards. See lib/aheadOrder.ts.
      const aheadRows: ReviewHighlight[] = []
      if (aheadMode) {
        const futureRows = allRows.filter((h) => h.date > today)
        const month = today.substring(0, 7)
        const { ordered, frozenIds } = reconcileAheadOrder(
          futureRows,
          readAheadOrder(user.id, month),
          (h) => h.highlight?.text?.length || 0
        )
        writeAheadOrder(user.id, month, frozenIds)
        aheadRows.push(...ordered)
      }

      const processed = [...todayRows, ...catchUpRows, ...aheadRows]

      setHighlights(processed)

      // Cache highlights for offline use
      try {
        await cacheReviewData({
          highlights: processed,
          categories: catResult.data || [],
          pinnedHighlightIds: pinIds,
          cachedAt: Date.now(),
        })
      } catch (e) {
        console.warn('Failed to cache review data:', e)
      }

      // Start at the first unrated highlight
      const firstUnrated = processed.findIndex((h) => h.rating === null)
      setCurrentIndex(firstUnrated >= 0 ? firstUnrated : 0)
    } catch (error) {
      console.error('Error loading highlights:', error)

      // Network failed — try to load from cache regardless of navigator.onLine
      // (handles weak signal where Wi-Fi is connected but internet is unreachable)
      try {
        const cached = await getCachedReviewData()
        if (cached) {
          setHighlights(cached.highlights)
          setCategories(cached.categories || [])
          setPinnedHighlightIds(new Set(cached.pinnedHighlightIds || []))
          setUsingCachedData(true)
          const firstUnrated = cached.highlights.findIndex((h: any) => h.rating === null)
          setCurrentIndex(firstUnrated >= 0 ? firstUnrated : 0)
        }
      } catch (cacheError) {
        console.error('Failed to load cached data:', cacheError)
      }
    } finally {
      setLoading(false)
    }
  }, [supabase, today, aheadMode])

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
        } else if (rateParam && ['low', 'med', 'high'].includes(rateParam)) {
          if (highlights[targetIndex].rating === null) {
            setTimeout(() => {
              handleRateByIndex(targetIndex, rateParam)
              router.replace('/review', { scroll: false })
            }, 300)
          } else {
            // Already rated — navigate to next unreviewed instead
            const nextUnrated = highlights.findIndex((h) => h.rating === null)
            if (nextUnrated >= 0) setCurrentIndex(nextUnrated)
            router.replace('/review', { scroll: false })
          }
        } else {
          router.replace('/review', { scroll: false })
        }
      } else {
        router.replace('/review', { scroll: false })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, highlights, searchParams])

  // Background-only: recalculate average rating and auto-archive after a rating is saved.
  // Called fire-and-forget so the UI doesn't wait for it.
  // The highlight_months_reviewed upsert is intentionally NOT here — it lives on the
  // critical path so it persists even if the user closes the app immediately after rating.
  const updateHighlightStats = async (
    highlightId: string,
    monthYear: string,
    mo: number,
    y: number
  ) => {
    const [{ data: allRatingsData }, { data: highlightData }, { data: lowRatingsWithDates }] = await Promise.all([
      supabase
        .from('daily_summary_highlights')
        .select('rating')
        .eq('highlight_id', highlightId)
        .not('rating', 'is', null),
      (supabase.from('highlights') as any)
        .select('unarchived_at')
        .eq('id', highlightId)
        .single(),
      supabase
        .from('daily_summary_highlights')
        .select('rating, daily_summary:daily_summaries!inner(date)')
        .eq('highlight_id', highlightId)
        .eq('rating', 'low'),
    ])

    const ratingMap: Record<string, number> = { low: 1, med: 2, high: 3 }
    const ratingValues = ((allRatingsData || []) as Array<{ rating: string }>)
      .map((r) => ratingMap[r.rating] || 0).filter((v) => v > 0)
    const average = ratingValues.length > 0
      ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
      : 0

    const unarchivedAt = highlightData?.unarchived_at?.split('T')[0]
    const lowMonths = new Set(
      ((lowRatingsWithDates || []) as Array<{ rating: string; daily_summary: { date: string } }>)
        .filter((r) => !unarchivedAt || r.daily_summary.date > unarchivedAt)
        .map((r) => r.daily_summary.date.substring(0, 7))
    )
    const prevMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
    const shouldArchive = lowMonths.has(monthYear) && lowMonths.has(prevMonth)

    await (supabase.from('highlights') as any)
      .update({
        average_rating: average,
        rating_count: ratingValues.length,
        ...(shouldArchive ? { archived: true } : {}),
      })
      .eq('id', highlightId)
  }

  // Helper to rate a specific highlight by index (for auto-rate from widget URL params)
  const handleRateByIndex = async (index: number, rating: 'low' | 'med' | 'high') => {
    const target = highlights[index]
    if (!target || ratingInProgress) return
    setRatingInProgress(true)

    try {
      // Optimistic UI + cache update so the rating survives an offline refresh.
      const applyRatingPatch = (h: ReviewHighlight) =>
        h.id === target.id ? { ...h, rating } : h
      setHighlights((prev) => prev.map(applyRatingPatch))
      await updateCache((c) => ({ highlights: c.highlights.map(applyRatingPatch) }))

      const [y, mo] = today.split('-').map(Number)
      const monthYear = `${y}-${String(mo).padStart(2, '0')}`

      // Critical path: save the rating AND mark this month as reviewed (source of truth).
      // Both must persist before we release the UI lock — otherwise closing the app
      // immediately after rating loses the highlight_months_reviewed row.
      await Promise.all([
        (supabase.from('daily_summary_highlights') as any)
          .update({ rating })
          .eq('id', target.id),
        (supabase.from('highlight_months_reviewed') as any)
          .upsert(
            { highlight_id: target.highlight_id, month_year: monthYear },
            { onConflict: 'highlight_id,month_year' }
          ),
      ])

      setHighlights((prev) => {
        const updated = prev.map((h) => (h.id === target.id ? { ...h, rating } : h))
        const nextUnrated = updated.findIndex((h) => h.rating === null)
        if (nextUnrated >= 0) setCurrentIndex(nextUnrated)
        return updated
      })
      setRatingInProgress(false)

      // Background: stats/auto-archive (doesn't block UI)
      updateHighlightStats(target.highlight_id, monthYear, mo, y).catch(console.error)
    } catch (error) {
      console.error('Error auto-rating highlight:', error)
      setHighlights((prev) =>
        prev.map((h) => (h.id === target.id ? { ...h, rating: null } : h))
      )
      setRatingInProgress(false)
    }
  }

  const todayHighlights = useMemo(
    () => highlights.filter((h) => h.date === today),
    [highlights, today]
  )

  const ratedCount = useMemo(
    () => todayHighlights.filter((h) => h.rating !== null).length,
    [todayHighlights]
  )

  const allDone =
    highlights.length > 0 && highlights.every((h) => h.rating !== null)

  // Header/progress denominator: today's count normally, the full queue in
  // ahead mode (so the bar reflects month-wide progress, not just today).
  const overallRatedCount = useMemo(
    () => highlights.filter((h) => h.rating !== null).length,
    [highlights]
  )
  const progressRated = aheadMode ? overallRatedCount : ratedCount
  const progressTotal = aheadMode ? highlights.length : todayHighlights.length

  const current = highlights[currentIndex] || null
  const isCatchUp = current ? current.date < today : false
  const isAhead = current ? current.date > today : false

  // Reset highlight content scroll to top whenever the displayed highlight changes,
  // so a long, scrolled-down highlight doesn't leave the next one mid-scroll.
  useEffect(() => {
    if (highlightContentRef.current) {
      highlightContentRef.current.scrollTop = 0
    }
    setBoldButtonPos(null)
  }, [current?.id])

  // Position the floating "B" pill when the user selects text inside the
  // highlight content. Hides on collapse, on selection elsewhere, or while
  // editing/splitting (the read view isn't rendered then).
  useEffect(() => {
    const onSelectionChange = () => {
      if (editingId || splitMode) {
        setBoldButtonPos(null)
        return
      }
      const sel = window.getSelection()
      const container = highlightContentRef.current
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !container) {
        setBoldButtonPos(null)
        return
      }
      const range = sel.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) {
        setBoldButtonPos(null)
        return
      }
      if (!range.toString().trim()) {
        setBoldButtonPos(null)
        return
      }
      const rect = range.getBoundingClientRect()
      setBoldButtonPos({
        top: rect.top - 44,
        left: rect.left + rect.width / 2,
      })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [editingId, splitMode])

  // ⌘B toggles bold on the current selection. ⌘Z / ⌘⇧Z (or ⌘Y) drive the
  // per-highlight undo/redo stack populated by toggleBoldOnSelection.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return

      const live = inlineHandlersRef.current
      if (live.editingId || live.splitMode || !live.currentHighlightId) return

      const key = e.key.toLowerCase()
      if (key === 'b') {
        const sel = window.getSelection()
        const container = highlightContentRef.current
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !container) return
        const range = sel.getRangeAt(0)
        if (!container.contains(range.commonAncestorContainer)) return
        if (!range.toString().trim()) return
        e.preventDefault()
        live.toggleBold()
      } else if (key === 'z' && !e.shiftKey) {
        const stack = undoStacksRef.current.get(live.currentHighlightId) || []
        if (stack.length === 0) return
        e.preventDefault()
        live.undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        const stack = redoStacksRef.current.get(live.currentHighlightId) || []
        if (stack.length === 0) return
        e.preventDefault()
        live.redo()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const handleRate = async (rating: 'low' | 'med' | 'high') => {
    if (!current || ratingInProgress) return
    setRatingInProgress(true)

    // Optimistic UI + cache update (runs whether online or offline).
    // The cache write must happen on every path — including the online success
    // path — so a refresh while offline restores the ratings instead of
    // reverting to the all-unrated snapshot from the last loadHighlights().
    const applyRatingPatch = (h: ReviewHighlight) =>
      h.id === current.id ? { ...h, rating } : h
    setHighlights((prev) => prev.map(applyRatingPatch))
    await updateCache((c) => ({ highlights: c.highlights.map(applyRatingPatch) }))

    // If offline, queue the action and update local state only
    if (!isOnline) {
      try {
        await enqueueOfflineAction({
          type: 'rate-review',
          params: {
            summaryHighlightId: current.id,
            highlightId: current.highlight_id,
            rating,
            today,
          },
        })
        // Move to next unrated
        setHighlights((prev) => {
          const updated = prev.map((h) =>
            h.id === current.id ? { ...h, rating } : h
          )
          const nextUnrated = updated.findIndex(
            (h, i) => h.rating === null && i !== currentIndex
          )
          if (nextUnrated >= 0) {
            setCurrentIndex(nextUnrated)
          }
          return updated
        })
      } catch (error) {
        console.error('Error queuing offline rating:', error)
        setHighlights((prev) =>
          prev.map((h) => (h.id === current.id ? { ...h, rating: null } : h))
        )
      } finally {
        setRatingInProgress(false)
      }
      return
    }

    try {
      const [y, mo] = today.split('-').map(Number)
      const monthYear = `${y}-${String(mo).padStart(2, '0')}`

      // Critical path: save the rating AND mark this month as reviewed (source of truth).
      // Both must persist before we release the UI lock — otherwise closing the app
      // immediately after rating loses the highlight_months_reviewed row.
      await Promise.all([
        (supabase.from('daily_summary_highlights') as any)
          .update({ rating })
          .eq('id', current.id),
        (supabase.from('highlight_months_reviewed') as any)
          .upsert(
            { highlight_id: current.highlight_id, month_year: monthYear },
            { onConflict: 'highlight_id,month_year' }
          ),
      ])

      setHighlights((prev) => {
        const updated = prev.map((h) =>
          h.id === current.id ? { ...h, rating } : h
        )
        const nextUnrated = updated.findIndex(
          (h, i) => h.rating === null && i !== currentIndex
        )
        if (nextUnrated >= 0) setCurrentIndex(nextUnrated)
        return updated
      })
      setRatingInProgress(false)

      // Background: stats/auto-archive (doesn't block UI)
      updateHighlightStats(current.highlight_id, monthYear, mo, y).catch(console.error)
    } catch (error) {
      console.error('Error rating highlight (falling back to offline queue):', error)
      // Network failed on weak signal — fall back to offline queueing
      // instead of reverting the rating. The optimistic UI update is already applied.
      try {
        await enqueueOfflineAction({
          type: 'rate-review',
          params: {
            summaryHighlightId: current.id,
            highlightId: current.highlight_id,
            rating,
            today,
          },
        })
        // Advance to next unrated highlight
        setHighlights((prev) => {
          const updated = prev.map((h) =>
            h.id === current.id ? { ...h, rating } : h
          )
          const nextUnrated = updated.findIndex(
            (h, i) => h.rating === null && i !== currentIndex
          )
          if (nextUnrated >= 0) {
            setCurrentIndex(nextUnrated)
          }
          return updated
        })
      } catch (queueError) {
        // If even queueing fails (IndexedDB issue), revert as last resort
        console.error('Failed to queue offline action:', queueError)
        setHighlights((prev) =>
          prev.map((h) => (h.id === current.id ? { ...h, rating: null } : h))
        )
      }
    } finally {
      setRatingInProgress(false)
    }
  }

  const goToNext = () => {
    if (currentIndex < highlights.length - 1) {
      setNavDirection('next')
      setCurrentIndex(currentIndex + 1)
    }
  }

  const goToPrev = () => {
    if (currentIndex > 0) {
      setNavDirection('prev')
      setCurrentIndex(currentIndex - 1)
    }
  }

  // ─── Split ────────────────────────────────────────────────

  const handleStartSplit = (highlight: any) => {
    const paragraphs = parseIntoParagraphs(highlight.html_content, highlight.text)
    if (paragraphs.length <= 1) {
      alert('This highlight has only one paragraph — nothing to split.')
      return
    }
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
    setSplitParagraphs([])
    setSplitPoints(new Set())
  }

  const handleConfirmSplit = async () => {
    if (!current || !current.highlight || splitPoints.size === 0) return
    setSplittingInProgress(true)
    try {
      const groups = groupParagraphsByDividers(splitParagraphs, splitPoints)
      if (groups.length <= 1) {
        alert('No split points selected.')
        setSplittingInProgress(false)
        return
      }

      const highlight = current.highlight
      const originalText = highlight.text
      const originalHtmlContent = highlight.html_content
      const firstGroup = groups[0]
      // Pre-generate UUIDs for new highlights so the same IDs work whether we
      // write to Supabase now (online) or replay later (offline).
      const newGroups = groups.slice(1).map((g) => ({
        id: crypto.randomUUID(),
        text: g.text,
        html: g.html,
      }))
      const categoryIds = (highlight.categories || []).map((cat) => cat.id)

      // Optimistic local + cache update (only first group's text changes;
      // new highlights appear after replay + reload, mirroring existing online behavior)
      const applySplitFirstPatch = (h: ReviewHighlight) =>
        h.highlight_id === highlight.id && h.highlight
          ? {
              ...h,
              highlight: {
                ...h.highlight,
                text: firstGroup.text,
                html_content: firstGroup.html,
              },
            }
          : h
      setHighlights((prev) => prev.map(applySplitFirstPatch))
      await updateCache((c) => ({ highlights: c.highlights.map(applySplitFirstPatch) }))

      if (!isOnline) {
        await enqueueOfflineAction({
          type: 'split-highlight',
          params: {
            originalHighlightId: highlight.id,
            originalText,
            originalHtmlContent,
            firstGroup: { text: firstGroup.text, html: firstGroup.html },
            newGroups,
            source: highlight.source || null,
            author: highlight.author || null,
            categoryIds,
          },
        })
        handleCancelSplit()
        return
      }

      // Update original highlight with first group
      const { error: firstGroupUpdateError } = await (supabase.from('highlights') as any)
        .update({
          text: firstGroup.text,
          html_content: firstGroup.html,
        })
        .eq('id', highlight.id)
      if (firstGroupUpdateError) throw firstGroupUpdateError

      // Sync original to Notion
      await addToSyncQueue(
        highlight.id, 'update',
        firstGroup.text, firstGroup.html,
        originalText, originalHtmlContent
      )

      // Create new highlights for remaining groups
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      const newHighlightIds: string[] = []
      for (const group of newGroups) {
        const { data: newHighlight, error } = await (supabase.from('highlights') as any)
          .insert({
            id: group.id,
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
        if (categoryIds.length > 0) {
          const categoryLinks = categoryIds.map((catId) => ({
            highlight_id: newHighlight.id,
            category_id: catId,
          }))
          await (supabase.from('highlight_categories') as any).insert(categoryLinks)
        }

        // Sync new highlight to Notion
        addToSyncQueue(
          newHighlight.id, 'add',
          group.text, group.html
        ).catch((err: any) => console.error('Error syncing split highlight:', err))
      }

      // Redistribute new highlights into daily schedule
      if (newHighlightIds.length > 0) {
        callRedistribute(newHighlightIds).catch(() => {})
      }

      handleCancelSplit()
    } catch (error) {
      console.error('Error splitting highlight:', error)
      alert('Failed to split highlight. Please try again.')
    } finally {
      setSplittingInProgress(false)
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
      const text = editText.trim()
      const htmlContent = editHtmlContent.trim() || null
      const source = editSource.trim() || null
      const author = editAuthor.trim() || null
      const categoryIds = [...editCategories]

      // Optimistic local + cache update (runs whether online or offline)
      const updatedCategories = categories.filter((c) => categoryIds.includes(c.id))
      const applyEditPatch = (h: ReviewHighlight) =>
        h.highlight_id === highlightId && h.highlight
          ? {
              ...h,
              highlight: {
                ...h.highlight,
                text,
                html_content: htmlContent,
                source,
                author,
                categories: updatedCategories,
              },
            }
          : h
      setHighlights((prev) => prev.map(applyEditPatch))
      await updateCache((c) => ({ highlights: c.highlights.map(applyEditPatch) }))

      if (!isOnline) {
        await enqueueOfflineAction({
          type: 'edit-highlight',
          params: {
            highlightId,
            text,
            htmlContent,
            source,
            author,
            categoryIds,
            skipNotionSync,
            originalText: original?.text || null,
            originalHtmlContent: original?.html_content || null,
          },
        })
        handleCancelEdit()
        return
      }

      const { error: updateError } = await (supabase.from('highlights') as any)
        .update({
          text,
          html_content: htmlContent,
          source,
          author,
          // "Don't sync to Notion": bump the opt-out marker so the
          // enqueue_notion_sync DB trigger skips this one edit.
          ...(skipNotionSync ? { notion_optout_marker: crypto.randomUUID() } : {}),
        })
        .eq('id', highlightId)
      if (updateError) throw updateError

      // Update categories
      await (supabase.from('highlight_categories') as any).delete().eq('highlight_id', highlightId)
      if (categoryIds.length > 0) {
        const categoryLinks = categoryIds.map((catId) => ({
          highlight_id: highlightId, category_id: catId,
        }))
        await (supabase.from('highlight_categories') as any).insert(categoryLinks)
      }

      // Notion sync — only if text/HTML actually changed (skip for category/source/author-only edits)
      const textChanged = text !== (original?.text || '') ||
        htmlContent !== (original?.html_content || null)
      if (!skipNotionSync && textChanged) {
        await addToSyncQueue(
          highlightId, 'update',
          text, htmlContent,
          original?.text || null, original?.html_content || null
        )
      }
      handleCancelEdit()
    } catch (error) {
      console.error('Error saving edit (falling back to offline queue):', error)
      try {
        await enqueueOfflineAction({
          type: 'edit-highlight',
          params: {
            highlightId: editingId,
            text: editText.trim(),
            htmlContent: editHtmlContent.trim() || null,
            source: editSource.trim() || null,
            author: editAuthor.trim() || null,
            categoryIds: [...editCategories],
            skipNotionSync,
            originalText: current?.highlight?.text || null,
            originalHtmlContent: current?.highlight?.html_content || null,
          },
        })
        handleCancelEdit()
      } catch (queueError) {
        console.error('Failed to queue offline edit:', queueError)
      }
    } finally {
      setUpdatingNotion(false)
    }
  }

  // ─── Inline formatting (bold) + undo/redo ──────────────────────────
  //
  // Lets users bold/unbold any text inside the highlight without entering edit
  // mode. Persists by writing a new html_content (same path as a full edit, but
  // text/source/author/categories unchanged). ⌘B toggles bold on the selection.
  // ⌘Z / ⌘⇧Z (or ⌘Y) undo/redo, scoped to the currently-displayed highlight.

  const persistInlineHtmlEdit = async (
    highlightId: string,
    newHtmlContent: string | null,
    originalHtmlContent: string | null,
  ) => {
    const target = highlights.find((h) => h.highlight_id === highlightId)?.highlight
    if (!target) return
    const text = target.text
    const source = target.source || null
    const author = target.author || null
    const categoryIds = (target.categories || []).map((c) => c.id)

    const applyPatch = (h: ReviewHighlight) =>
      h.highlight_id === highlightId && h.highlight
        ? { ...h, highlight: { ...h.highlight, html_content: newHtmlContent } }
        : h
    setHighlights((prev) => prev.map(applyPatch))
    await updateCache((c) => ({ highlights: c.highlights.map(applyPatch) }))

    const offlinePayload = {
      type: 'edit-highlight' as const,
      params: {
        highlightId,
        text,
        htmlContent: newHtmlContent,
        source,
        author,
        categoryIds,
        skipNotionSync: false,
        originalText: text,
        originalHtmlContent,
      },
    }

    if (!isOnline) {
      await enqueueOfflineAction(offlinePayload)
      return
    }

    try {
      const { error } = await (supabase.from('highlights') as any)
        .update({ html_content: newHtmlContent })
        .eq('id', highlightId)
      if (error) throw error
      await addToSyncQueue(
        highlightId,
        'update',
        text,
        newHtmlContent,
        text,
        originalHtmlContent,
      )
    } catch (error) {
      console.error('Inline format save failed, queuing offline:', error)
      try {
        await enqueueOfflineAction(offlinePayload)
      } catch (queueError) {
        console.error('Failed to queue offline inline edit:', queueError)
      }
    }
  }

  const pushUndoSnapshot = (highlightId: string, beforeHtml: string | null) => {
    const stack = undoStacksRef.current.get(highlightId) || []
    stack.push(beforeHtml ?? '')
    undoStacksRef.current.set(highlightId, stack)
    redoStacksRef.current.set(highlightId, []) // new branch
    setHistoryVersion((v) => v + 1)
  }

  const toggleBoldOnSelection = async () => {
    if (editingId || splitMode) return
    if (!current?.highlight) return

    const container = highlightContentRef.current
    if (!container) return

    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return

    const range = sel.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) return
    if (!range.toString().trim()) return

    const highlightId = current.highlight.id
    const originalHtml = current.highlight.html_content || null

    // Look for an enclosing <strong>/<b> — if the selection sits inside one,
    // treat the action as "unbold" by unwrapping that ancestor.
    let strongAncestor: HTMLElement | null = null
    let node: Node | null = range.commonAncestorContainer
    while (node && node !== container) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName
        if (tag === 'STRONG' || tag === 'B') {
          strongAncestor = node as HTMLElement
          break
        }
      }
      node = node.parentNode
    }

    try {
      if (strongAncestor) {
        const parent = strongAncestor.parentNode
        if (!parent) return
        while (strongAncestor.firstChild) {
          parent.insertBefore(strongAncestor.firstChild, strongAncestor)
        }
        parent.removeChild(strongAncestor)
      } else {
        const fragment = range.extractContents()
        const strong = document.createElement('strong')
        strong.appendChild(fragment)
        range.insertNode(strong)
      }
    } catch (err) {
      // Range mutations can throw on awkward selections that span node boundaries
      // in incompatible ways. Safer to bail than to leave the DOM in a half state.
      console.warn('Bold toggle failed:', err)
      return
    }

    sel.removeAllRanges()
    setBoldButtonPos(null)

    const newHtml = container.innerHTML
    pushUndoSnapshot(highlightId, originalHtml)
    await persistInlineHtmlEdit(highlightId, newHtml, originalHtml)
  }

  const handleInlineUndo = async () => {
    if (editingId || splitMode) return
    if (!current?.highlight) return
    const highlightId = current.highlight.id
    const undoStack = undoStacksRef.current.get(highlightId) || []
    if (undoStack.length === 0) return

    const previousHtml = undoStack[undoStack.length - 1]
    undoStacksRef.current.set(highlightId, undoStack.slice(0, -1))

    const currentHtml = current.highlight.html_content || ''
    const redoStack = redoStacksRef.current.get(highlightId) || []
    redoStack.push(currentHtml)
    redoStacksRef.current.set(highlightId, redoStack)

    setHistoryVersion((v) => v + 1)
    await persistInlineHtmlEdit(highlightId, previousHtml || null, currentHtml || null)
  }

  const handleInlineRedo = async () => {
    if (editingId || splitMode) return
    if (!current?.highlight) return
    const highlightId = current.highlight.id
    const redoStack = redoStacksRef.current.get(highlightId) || []
    if (redoStack.length === 0) return

    const nextHtml = redoStack[redoStack.length - 1]
    redoStacksRef.current.set(highlightId, redoStack.slice(0, -1))

    const currentHtml = current.highlight.html_content || ''
    const undoStack = undoStacksRef.current.get(highlightId) || []
    undoStack.push(currentHtml)
    undoStacksRef.current.set(highlightId, undoStack)

    setHistoryVersion((v) => v + 1)
    await persistInlineHtmlEdit(highlightId, nextHtml || null, currentHtml || null)
  }

  // Bundled live state for the keydown listener — bound once, reads latest via ref.
  const inlineHandlersRef = useRef({
    currentHighlightId: null as string | null,
    editingId: null as string | null,
    splitMode: false,
    toggleBold: (async () => {}) as () => Promise<void>,
    undo: (async () => {}) as () => Promise<void>,
    redo: (async () => {}) as () => Promise<void>,
  })
  inlineHandlersRef.current = {
    currentHighlightId: current?.highlight?.id || null,
    editingId,
    splitMode,
    toggleBold: toggleBoldOnSelection,
    undo: handleInlineUndo,
    redo: handleInlineRedo,
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

    // Optimistic local + cache update
    const applyArchivePatch = (h: ReviewHighlight) =>
      h.highlight_id === highlightId && h.highlight
        ? { ...h, highlight: { ...h.highlight, archived: true } }
        : h
    setHighlights((prev) => prev.map(applyArchivePatch))
    await updateCache((c) => ({ highlights: c.highlights.map(applyArchivePatch) }))

    if (!isOnline) {
      await enqueueOfflineAction({ type: 'archive-highlight', params: { highlightId } })
      return
    }

    try {
      await (supabase.from('highlights') as any)
        .update({ archived: true })
        .eq('id', highlightId)
      await removeFromFutureMonths(supabase, highlightId)
    } catch (error) {
      console.error('Error archiving highlight (falling back to offline queue):', error)
      try {
        await enqueueOfflineAction({ type: 'archive-highlight', params: { highlightId } })
      } catch (queueError) {
        console.error('Failed to queue offline archive:', queueError)
      }
    }
  }

  const handleUnarchiveHighlight = async (highlightId: string) => {
    // Optimistic local + cache update
    const applyUnarchivePatch = (h: ReviewHighlight) =>
      h.highlight_id === highlightId && h.highlight
        ? { ...h, highlight: { ...h.highlight, archived: false } }
        : h
    setHighlights((prev) => prev.map(applyUnarchivePatch))
    await updateCache((c) => ({ highlights: c.highlights.map(applyUnarchivePatch) }))

    if (!isOnline) {
      await enqueueOfflineAction({ type: 'unarchive-highlight', params: { highlightId } })
      return
    }

    try {
      await (supabase.from('highlights') as any)
        .update({ archived: false, unarchived_at: new Date().toISOString() })
        .eq('id', highlightId)
    } catch (error) {
      console.error('Error unarchiving highlight (falling back to offline queue):', error)
      try {
        await enqueueOfflineAction({ type: 'unarchive-highlight', params: { highlightId } })
      } catch (queueError) {
        console.error('Failed to queue offline unarchive:', queueError)
      }
    }
  }

  // ─── Delete ───────────────────────────────────────────────

  const handleDeleteHighlight = async (highlightId: string) => {
    if (!confirm('Are you sure you want to delete this highlight? This cannot be undone.')) return

    const h = highlights.find((h) => h.highlight_id === highlightId)
    const text = h?.highlight?.text || null
    const htmlContent = h?.highlight?.html_content || null

    // Optimistic local + cache update
    setHighlights((prev) => prev.filter((h) => h.highlight_id !== highlightId))
    setCurrentIndex((prev) => Math.min(prev, highlights.length - 2))
    await updateCache((c) => ({
      highlights: c.highlights.filter((h: any) => h.highlight_id !== highlightId),
    }))

    if (!isOnline) {
      await enqueueOfflineAction({
        type: 'delete-highlight',
        params: { highlightId, text, htmlContent },
      })
      return
    }

    try {
      // Delete from DB first; only ping the Notion sync badge on success so we
      // don't refresh stale state if the row is still present.
      const { error: deleteError } = await (supabase.from('highlights') as any).delete().eq('id', highlightId)
      if (deleteError) throw deleteError

      await addToSyncQueue(highlightId, 'delete', text, htmlContent)
      callRedistribute() // fire-and-forget
    } catch (error) {
      console.error('Error deleting highlight (falling back to offline queue):', error)
      try {
        await enqueueOfflineAction({
          type: 'delete-highlight',
          params: { highlightId, text, htmlContent },
        })
      } catch (queueError) {
        console.error('Failed to queue offline delete:', queueError)
      }
    }
  }

  // ─── Pin ──────────────────────────────────────────────────

  const handlePin = async (highlightId: string) => {
    const isPinned = pinnedHighlightIds.has(highlightId)

    if (isPinned) {
      // Optimistic unpin + cache
      setPinnedHighlightIds((prev) => { const next = new Set(prev); next.delete(highlightId); return next })
      await updateCache((c) => ({ pinnedHighlightIds: c.pinnedHighlightIds.filter((id) => id !== highlightId) }))

      if (!isOnline) {
        await enqueueOfflineAction({ type: 'unpin-highlight', params: { highlightId } })
        return
      }

      try {
        const response = await fetch(`/api/pins?highlightId=${highlightId}`, { method: 'DELETE' })
        if (!response.ok) throw new Error('Unpin request failed')
      } catch (error) {
        console.error('Error unpinning (falling back to offline queue):', error)
        try {
          await enqueueOfflineAction({ type: 'unpin-highlight', params: { highlightId } })
        } catch (queueError) {
          console.error('Failed to queue offline unpin:', queueError)
        }
      }
      return
    }

    // Pin path — enforce the 10-pin client cap using the local cache so the
    // dialog flow works offline too.
    if (pinnedHighlightIds.size >= 10) {
      setPendingPinHighlightId(highlightId)
      setPinDialogOpen(true)
      return
    }

    // Optimistic pin + cache
    setPinnedHighlightIds((prev) => new Set(prev).add(highlightId))
    await updateCache((c) => ({
      pinnedHighlightIds: c.pinnedHighlightIds.includes(highlightId)
        ? c.pinnedHighlightIds
        : [...c.pinnedHighlightIds, highlightId],
    }))

    if (!isOnline) {
      await enqueueOfflineAction({ type: 'pin-highlight', params: { highlightId } })
      return
    }

    try {
      const response = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlightId }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        if (data.isFull) {
          // Server-side count > local cache (another device pinned things).
          // Revert optimistic, open the dialog so the user can choose which to drop.
          setPinnedHighlightIds((prev) => { const next = new Set(prev); next.delete(highlightId); return next })
          await updateCache((c) => ({ pinnedHighlightIds: c.pinnedHighlightIds.filter((id) => id !== highlightId) }))
          setPendingPinHighlightId(highlightId)
          setPinDialogOpen(true)
          return
        }
        throw new Error('Pin request failed')
      }
    } catch (error) {
      console.error('Error pinning (falling back to offline queue):', error)
      try {
        await enqueueOfflineAction({ type: 'pin-highlight', params: { highlightId } })
      } catch (queueError) {
        console.error('Failed to queue offline pin:', queueError)
      }
    }
  }

  const handleRemoveFromPinBoard = async (highlightIdToRemove: string) => {
    // Optimistic unpin + cache
    setPinnedHighlightIds((prev) => { const next = new Set(prev); next.delete(highlightIdToRemove); return next })
    await updateCache((c) => ({ pinnedHighlightIds: c.pinnedHighlightIds.filter((id) => id !== highlightIdToRemove) }))

    if (isOnline) {
      try {
        await fetch(`/api/pins?highlightId=${highlightIdToRemove}`, { method: 'DELETE' })
      } catch (error) {
        console.error('Error unpinning from board (falling back to offline queue):', error)
        await enqueueOfflineAction({ type: 'unpin-highlight', params: { highlightId: highlightIdToRemove } }).catch(() => {})
      }
    } else {
      await enqueueOfflineAction({ type: 'unpin-highlight', params: { highlightId: highlightIdToRemove } })
    }

    if (pendingPinHighlightId) {
      // Now pin the pending one
      const newPinId = pendingPinHighlightId
      setPinnedHighlightIds((prev) => new Set(prev).add(newPinId))
      await updateCache((c) => ({
        pinnedHighlightIds: c.pinnedHighlightIds.includes(newPinId)
          ? c.pinnedHighlightIds
          : [...c.pinnedHighlightIds, newPinId],
      }))

      if (isOnline) {
        try {
          const pinResponse = await fetch('/api/pins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlightId: newPinId }),
          })
          if (!pinResponse.ok) {
            await enqueueOfflineAction({ type: 'pin-highlight', params: { highlightId: newPinId } })
          }
        } catch (error) {
          console.error('Error pinning replacement (falling back to offline queue):', error)
          await enqueueOfflineAction({ type: 'pin-highlight', params: { highlightId: newPinId } }).catch(() => {})
        }
      } else {
        await enqueueOfflineAction({ type: 'pin-highlight', params: { highlightId: newPinId } })
      }

      setPendingPinHighlightId(null)
      setPinDialogOpen(false)
    }
  }

  // ─── Offline Sync ─────────────────────────────────────────

  // Replaying the offline queue is owned by the global <OfflineSync> in the
  // root layout, so it drains on reconnect from ANY page (not just here). When
  // a sync finishes and something was persisted, reload to show server truth.
  useEffect(() => {
    const onComplete = (e: Event) => {
      const result = (e as CustomEvent).detail
      if (result?.processed > 0 || result?.touchedHighlights) loadHighlights()
    }
    window.addEventListener('offline-sync-complete', onComplete)
    return () => window.removeEventListener('offline-sync-complete', onComplete)
  }, [loadHighlights])

  // ─── Render ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-6">
        <div className="text-xl text-gray-600 dark:text-gray-300">Loading...</div>
        <Link href="/review/lite" className="text-sm text-blue-600 dark:text-blue-400 underline">
          Slow connection? Switch to text-only →
        </Link>
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

  if (allDone && !searchParams.get('id')) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-6">
        <div className="text-6xl mb-4">🎉</div>
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2 text-center">
          All Done!
        </h2>
        <p className="text-gray-600 dark:text-gray-300 mb-6 text-center">
          {aheadMode
            ? `You're ahead through the end of the month — all ${highlights.length} highlights reviewed.`
            : highlights.length === todayHighlights.length
            ? `You reviewed all ${todayHighlights.length} highlights for today.`
            : `You're all caught up — ${todayHighlights.length} today plus ${highlights.length - todayHighlights.length} from earlier this month.`}
        </p>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          {!aheadMode && (
            <Link
              href="/review?ahead=1"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-medium whitespace-nowrap"
            >
              Review ahead
              <ArrowRight className="w-4 h-4" />
            </Link>
          )}
          <div className="flex gap-3">
            <Link
              href="/"
              className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl transition font-medium whitespace-nowrap ${
                aheadMode
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
              }`}
            >
              <Home className="w-4 h-4" />
              Home
            </Link>
            <Link
              href="/daily"
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl hover:bg-gray-300 dark:hover:bg-gray-600 transition font-medium whitespace-nowrap"
            >
              <CalendarDays className="w-4 h-4" />
              Daily
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      {/* Offline Banner */}
      <OfflineBanner isOnline={isOnline} isSyncing={isSyncing} pendingCount={pendingSyncCount} />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 safe-area-top">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {progressRated} / {progressTotal} reviewed{aheadMode ? ' this month' : ''}
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/review/lite"
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
            title="Minimal text-only view for weak connections"
          >
            Lite
          </Link>
          <Link
            href="/daily"
            className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition"
          >
            Full View
          </Link>
        </div>
      </div>

      {/* Progress bar */}
      <div className="px-4">
        <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${
                progressTotal === 0
                  ? 0
                  : (progressRated / progressTotal) * 100
              }%`,
            }}
          />
        </div>
      </div>

      {/* Main card area */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6">
        {current && current.highlight && (
          <div className="w-full max-w-lg">
            {/* Highlight card */}
            <div
              key={current.highlight.id}
              className={`bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6 mb-4 ${
                navDirection === 'prev' ? 'review-card-enter-prev' : 'review-card-enter-next'
              } ${current.highlight.archived ? 'opacity-60 border-2 border-orange-300 dark:border-orange-700' : ''}`}
            >
              {isCatchUp && (
                <div className="mb-2 px-2 py-1 bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200 rounded text-xs font-semibold inline-block">
                  Catching up · {format(new Date(`${current.date}T00:00:00`), 'MMM d')}
                </div>
              )}
              {isAhead && (
                <div className="mb-2 px-2 py-1 bg-teal-100 dark:bg-teal-900 text-teal-800 dark:text-teal-200 rounded text-xs font-semibold inline-block">
                  Reviewing ahead · {format(new Date(`${current.date}T00:00:00`), 'MMM d')}
                </div>
              )}
              {current.highlight.archived && (
                <div className="mb-2 px-2 py-1 bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 rounded text-xs font-semibold inline-block">
                  Archived
                </div>
              )}

              {splitMode ? (
                /* ─── Split UI ─── */
                <div className="space-y-2">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm font-semibold text-purple-700 dark:text-purple-300">
                      Tap dividers to set split points
                    </span>
                  </div>
                  <div className="max-h-[28em] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
                    {splitParagraphs.map((para, i) => {
                      // Determine which group this paragraph belongs to
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
                        'bg-teal-50 dark:bg-teal-900/20 border-l-teal-400',
                        'bg-indigo-50 dark:bg-indigo-900/20 border-l-indigo-400',
                      ]
                      const colorClass = groupColors[groupIndex % groupColors.length]

                      return (
                        <div key={i}>
                          <div
                            className={`px-4 py-3 border-l-4 ${colorClass} prose dark:prose-invert max-w-none text-sm`}
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
                              {splitPoints.has(i) ? (
                                <>Cut here</>
                              ) : (
                                <span>· · ·</span>
                              )}
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
              ) : editingId === current.highlight.id ? (
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
                    ref={highlightContentRef}
                    className="highlight-content text-base mb-3 prose dark:prose-invert max-w-none overflow-y-auto"
                    style={{ maxHeight: '24em' }}
                    dangerouslySetInnerHTML={{
                      __html: renderHighlightHtml(current.highlight.html_content, current.highlight.text),
                    }}
                  />

                  {(current.highlight.source || current.highlight.author) && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {current.highlight.author && <span>{current.highlight.author}</span>}
                      {current.highlight.author && current.highlight.source && <span> &middot; </span>}
                      {current.highlight.source && <span>{current.highlight.source}</span>}
                    </p>
                  )}

                </>
              )}
            </div>

            {/* Rating buttons */}
            {!editingId && (
              <>
                <div className="flex gap-3">
                  <button
                    onClick={() => handleRate('low')}
                    disabled={ratingInProgress}
                    className={`flex-1 py-4 text-lg font-semibold rounded-xl transition-all transform hover:scale-105 active:scale-95 border-2 disabled:opacity-50 ${
                      current.rating === 'low'
                        ? 'bg-red-500 text-white border-red-600 ring-2 ring-red-400 ring-offset-1'
                        : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700'
                    }`}
                  >
                    Low
                  </button>
                  <button
                    onClick={() => handleRate('med')}
                    disabled={ratingInProgress}
                    className={`flex-1 py-4 text-lg font-semibold rounded-xl transition-all transform hover:scale-105 active:scale-95 border-2 disabled:opacity-50 ${
                      current.rating === 'med'
                        ? 'bg-yellow-500 text-white border-yellow-600 ring-2 ring-yellow-400 ring-offset-1'
                        : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-yellow-300 dark:border-yellow-700'
                    }`}
                  >
                    Med
                  </button>
                  <button
                    onClick={() => handleRate('high')}
                    disabled={ratingInProgress}
                    className={`flex-1 py-4 text-lg font-semibold rounded-xl transition-all transform hover:scale-105 active:scale-95 border-2 disabled:opacity-50 ${
                      current.rating === 'high'
                        ? 'bg-green-500 text-white border-green-600 ring-2 ring-green-400 ring-offset-1'
                        : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700'
                    }`}
                  >
                    High
                  </button>
                </div>
                <div className="flex gap-3 mt-3">
                  <button
                    onClick={goToPrev}
                    disabled={currentIndex === 0}
                    className="flex-1 py-2.5 text-base font-medium rounded-xl bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 transition disabled:opacity-30"
                  >
                    Prev
                  </button>
                  <button
                    onClick={goToNext}
                    disabled={currentIndex === highlights.length - 1}
                    className="flex-1 py-2.5 text-base font-medium rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-30"
                  >
                    Next
                  </button>
                </div>

                {/* Action buttons */}
                <div className="flex gap-2 mt-3 justify-center flex-wrap">
                  <button
                    onClick={() => handleStartEdit(current.highlight)}
                    className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleStartSplit(current.highlight)}
                    className="px-3 py-1 text-sm bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded hover:bg-purple-200 dark:hover:bg-purple-800 transition flex items-center gap-1"
                    title="Split into multiple highlights"
                  >
                    Split
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
            <div className="mt-6">
              {showDots && (
                <div className="flex justify-center gap-1.5 flex-wrap">
                  {highlights.map((h, i) => (
                    <button
                      key={h.id}
                      onClick={() => {
                        if (i === currentIndex) return
                        setNavDirection(i > currentIndex ? 'next' : 'prev')
                        setCurrentIndex(i)
                      }}
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
              )}
              <div className="flex justify-center mt-2">
                <button
                  onClick={() => setShowDots((prev) => !prev)}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition"
                >
                  {showDots ? 'Hide dots' : 'Show dots'}
                </button>
              </div>
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

      {/* Floating Bold pill — appears above any selection inside the highlight content */}
      {boldButtonPos && !editingId && !splitMode && (
        <button
          type="button"
          // preventDefault on mousedown keeps the text selection alive when the
          // button is clicked (otherwise the browser collapses it on focus shift).
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.preventDefault()}
          onClick={() => toggleBoldOnSelection()}
          title="Bold (⌘B). Undo with ⌘Z."
          aria-label="Bold selection"
          className="fixed z-50 -translate-x-1/2 px-3 py-1.5 rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-bold shadow-lg hover:bg-gray-700 dark:hover:bg-gray-300 transition"
          style={{ top: boldButtonPos.top, left: boldButtonPos.left }}
        >
          B
        </button>
      )}

      {/* Undo / Redo affordance for inline formatting — only shows when there's history for the current highlight */}
      {current?.highlight && !editingId && !splitMode && (() => {
        const hid = current.highlight.id
        const undoLen = (undoStacksRef.current.get(hid) || []).length
        const redoLen = (redoStacksRef.current.get(hid) || []).length
        if (undoLen === 0 && redoLen === 0) return null
        return (
          <div className="fixed bottom-4 right-4 z-40 flex gap-2 bg-white/95 dark:bg-gray-800/95 backdrop-blur rounded-full shadow-lg px-2 py-1.5 border border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={() => handleInlineUndo()}
              disabled={undoLen === 0}
              title="Undo (⌘Z)"
              aria-label="Undo"
              className="px-2 py-1 text-sm rounded-full text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              ↶ Undo
            </button>
            <button
              type="button"
              onClick={() => handleInlineRedo()}
              disabled={redoLen === 0}
              title="Redo (⌘⇧Z)"
              aria-label="Redo"
              className="px-2 py-1 text-sm rounded-full text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              ↷ Redo
            </button>
          </div>
        )
      })()}
    </div>
  )
}
