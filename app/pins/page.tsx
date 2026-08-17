'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Pin, PinOff } from 'lucide-react'
import PinDialog from '@/components/PinDialog'
import { renderHighlightHtml } from '@/lib/renderHighlightHtml'
import ActionToast, { useActionToast } from '@/components/ActionToast'
import SelectModeBar, { SelectCheck, archiveActionError } from '@/components/SelectModeBar'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import { removeFromFutureMonths } from '@/lib/removeFromFutureMonths'
import { getUserReviewSettings, getCycleForDate } from '@/lib/cycle'

interface PinnedHighlight {
  id: string
  highlight_id: string
  pinned_at: string
  highlights: {
    id: string
    text: string
    html_content: string | null
    created_at: string
    archived?: boolean
  }
}

export default function PinsPage() {
  const [pinnedHighlights, setPinnedHighlights] = useState<PinnedHighlight[]>([])
  const [loading, setLoading] = useState(true)
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)
  const [assignedDates, setAssignedDates] = useState<Map<string, string>>(new Map())
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkWorking, setBulkWorking] = useState(false)
  const { toast, showToast } = useActionToast()
  const supabase = createClient()

  const loadPinnedHighlights = useCallback(async () => {
    try {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        return
      }

      const { data, error } = await (supabase
        .from('pinned_highlights') as any)
        .select(`
          id,
          highlight_id,
          pinned_at,
          highlights (
            id,
            text,
            html_content,
            created_at,
            archived
          )
        `)
        .eq('user_id', user.id)
        .order('pinned_at', { ascending: false })

      if (error) throw error

      const pinned = (data || []) as PinnedHighlight[]
      setPinnedHighlights(pinned)
      setPinnedHighlightIds(new Set(pinned.map((p) => p.highlight_id)))

      // Fetch assigned review dates for the current cycle
      try {
        const now = new Date()
        const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        let freq = 1
        try {
          ;({ freq } = await getUserReviewSettings(supabase, user.id))
        } catch { /* default to monthly */ }
        const cycle = getCycleForDate(todayIso, freq)

        const highlightIds = pinned.map((p) => p.highlight_id).filter(Boolean)
        if (highlightIds.length > 0) {
          const { data: summaries } = await (supabase
            .from('daily_summaries') as any)
            .select('date, daily_summary_highlights(highlight_id)')
            .eq('user_id', user.id)
            .gte('date', cycle.startDate)
            .lte('date', cycle.endDate)
          const dateMap = new Map<string, string>()
          for (const ds of (summaries || []) as Array<{ date: string; daily_summary_highlights: Array<{ highlight_id: string }> }>) {
            for (const dsh of ds.daily_summary_highlights || []) {
              if (highlightIds.includes(dsh.highlight_id)) {
                dateMap.set(dsh.highlight_id, ds.date)
              }
            }
          }
          setAssignedDates(dateMap)
        }
      } catch (e) {
        // Non-critical: "Review on" tags just won't appear
      }
    } catch (error) {
      console.error('Error loading pinned highlights:', error)
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    loadPinnedHighlights()
  }, [loadPinnedHighlights])

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

        // Reload to update the list
        await loadPinnedHighlights()
        showToast('Highlight unpinned')
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
        await loadPinnedHighlights()
        showToast('Highlight pinned')
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
          await loadPinnedHighlights()
        }
      } else {
        // Reload to update the list
        await loadPinnedHighlights()
      }
      showToast('Removed from pin board')
    } catch (error: any) {
      console.error('Error removing from pin board:', error)
      alert(error.message || 'Failed to remove highlight from pin board')
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
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allOnPageSelected =
    pinnedHighlights.length > 0 &&
    pinnedHighlights.every((p) => p.highlights && selectedIds.has(p.highlights.id))

  const toggleSelectPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) {
        pinnedHighlights.forEach((p) => {
          if (p.highlights) next.delete(p.highlights.id)
        })
      } else {
        pinnedHighlights.forEach((p) => {
          if (p.highlights) next.add(p.highlights.id)
        })
      }
      return next
    })
  }

  const selectedPins = pinnedHighlights.filter(
    (p) => p.highlights && selectedIds.has(p.highlights.id)
  )
  const handleBulkArchive = async (archive: boolean) => {
    const ids = selectedPins.map((p) => p.highlights.id)
    if (ids.length === 0 || bulkWorking) return
    const mismatch = archiveActionError(
      archive ? 'archive' : 'unarchive',
      selectedPins.map((p) => p.highlights)
    )
    if (mismatch) {
      alert(mismatch)
      return
    }
    const verb = archive ? 'archive' : 'unarchive'
    if (!confirm(`Are you sure you want to ${verb} ${ids.length} highlight${ids.length === 1 ? '' : 's'}?`)) return

    setBulkWorking(true)
    try {
      const patch = archive
        ? { archived: true }
        : { archived: false, unarchived_at: new Date().toISOString() }
      const { error } = await (supabase.from('highlights') as any).update(patch).in('id', ids)
      if (error) throw error
      if (archive) {
        await Promise.all(ids.map((id) => removeFromFutureMonths(supabase, id).catch(() => {})))
      }
      setSelectedIds(new Set())
      setSelectMode(false)
      await loadPinnedHighlights()
      showToast(`${ids.length} highlight${ids.length === 1 ? '' : 's'} ${verb}d`)
    } catch (error) {
      console.error(`Error bulk ${verb}ing highlights:`, error)
      alert(`Failed to ${verb} highlights. Please try again.`)
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
      const byId = new Map(
        pinnedHighlights
          .filter((p) => p.highlights)
          .map((p) => [p.highlights.id, p.highlights])
      )
      const { error } = await (supabase.from('highlights') as any).delete().in('id', ids)
      if (error) throw error
      for (const id of ids) {
        const h = byId.get(id)
        addToNotionSyncQueue({
          highlightId: id,
          operationType: 'delete',
          text: h?.text ?? null,
          htmlContent: h?.html_content ?? null,
        }).catch((err) => console.error('Error queueing Notion delete:', err))
      }
      await fetch('/api/daily/redistribute', { method: 'POST' }).catch(() => {})
      setSelectedIds(new Set())
      setSelectMode(false)
      await loadPinnedHighlights()
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
      <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-4xl mx-auto">
            <div className="text-center py-12">
              <div className="text-xl text-gray-600 dark:text-gray-400">Loading pin board...</div>
            </div>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white mb-2">
              Pin Board
            </h1>
            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300">
              {pinnedHighlights.length} of 10 highlights pinned
            </p>
            </div>
            {pinnedHighlights.length > 0 && (
              <button
                onClick={toggleSelectMode}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-full transition-all text-sm font-medium self-start ${
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

          {pinnedHighlights.length === 0 ? (
            <div className="bg-white dark:bg-gray-800 p-8 sm:p-12 rounded-lg shadow-lg text-center">
              <Pin className="w-16 h-16 text-gray-400 dark:text-gray-600 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
                Your pin board is empty
              </h2>
              <p className="text-gray-600 dark:text-gray-300 mb-4">
                Pin highlights from the Daily Review, Highlights, or Search pages to see them here.
              </p>
              <Link
                href="/highlights"
                className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Go to Highlights
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              {pinnedHighlights.map((pin) => {
                const highlight = pin.highlights
                if (!highlight) return null

                return (
                  <div
                    key={pin.id}
                    onClick={selectMode ? () => toggleSelected(highlight.id) : undefined}
                    className={`relative bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 ${
                      selectMode ? 'cursor-pointer select-none' : ''
                    } ${selectMode && selectedIds.has(highlight.id) ? 'ring-2 ring-blue-500' : ''} ${
                      highlight.archived ? 'opacity-60 border-orange-300 dark:border-orange-700' : ''
                    }`}
                  >
                    {selectMode && <SelectCheck selected={selectedIds.has(highlight.id)} />}
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <div className="flex-1">
                        <div
                          className="highlight-content text-base mb-3 prose dark:prose-invert max-w-none"
                          dangerouslySetInnerHTML={{
                            __html: renderHighlightHtml(highlight.html_content, highlight.text),
                          }}
                        />
                        <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                          {assignedDates.has(highlight.id) && (
                            <span className="text-gray-500 dark:text-gray-400">
                              Review on {(() => {
                                const raw = assignedDates.get(highlight.id)!
                                const [, m, d] = String(raw).split('T')[0].split('-').map(Number)
                                return `${m}/${d}`
                              })()}
                            </span>
                          )}
                          <span>
                            Pinned {new Date(pin.pinned_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                          <span>
                            Created {new Date(highlight.created_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                        </div>
                      </div>
                      {!selectMode && (
                      <button
                        onClick={() => handlePin(highlight.id)}
                        className={`flex-shrink-0 px-3 py-2 rounded-lg transition ${
                          pinnedHighlightIds.has(highlight.id)
                            ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-800'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                        }`}
                        title={pinnedHighlightIds.has(highlight.id) ? 'Unpin' : 'Pin'}
                      >
                        {pinnedHighlightIds.has(highlight.id) ? (
                          <PinOff className="w-5 h-5" />
                        ) : (
                          <Pin className="w-5 h-5" />
                        )}
                      </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      {selectMode && pinnedHighlights.length > 0 && (
        <SelectModeBar
          selectedCount={selectedIds.size}
          allOnPageSelected={allOnPageSelected}
          bulkWorking={bulkWorking}
          onTogglePage={toggleSelectPage}
          selectPageLabel="Select all"
          deselectPageLabel="Deselect all"
          onArchive={() => handleBulkArchive(true)}
          onUnarchive={() => handleBulkArchive(false)}
          onDelete={handleBulkDelete}
          onCancel={toggleSelectMode}
        />
      )}
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
      <ActionToast toast={toast} />
    </main>
  )
}

