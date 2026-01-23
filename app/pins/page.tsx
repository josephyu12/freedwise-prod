'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Pin, PinOff } from 'lucide-react'
import PinDialog from '@/components/PinDialog'

interface PinnedHighlight {
  id: string
  highlight_id: string
  pinned_at: string
  highlights: {
    id: string
    text: string
    html_content: string | null
    created_at: string
  }
}

export default function PinsPage() {
  const [pinnedHighlights, setPinnedHighlights] = useState<PinnedHighlight[]>([])
  const [loading, setLoading] = useState(true)
  const [pinnedHighlightIds, setPinnedHighlightIds] = useState<Set<string>>(new Set())
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pendingPinHighlightId, setPendingPinHighlightId] = useState<string | null>(null)
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
            created_at
          )
        `)
        .eq('user_id', user.id)
        .order('pinned_at', { ascending: false })

      if (error) throw error

      const pinned = (data || []) as PinnedHighlight[]
      setPinnedHighlights(pinned)
      setPinnedHighlightIds(new Set(pinned.map((p) => p.highlight_id)))
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
    } catch (error: any) {
      console.error('Error removing from pin board:', error)
      alert(error.message || 'Failed to remove highlight from pin board')
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
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6 sm:mb-8">
            <div>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white mb-2">
                Pin Board
              </h1>
              <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300">
                {pinnedHighlights.length} of 10 highlights pinned
              </p>
            </div>
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
                    className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700"
                  >
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <div className="flex-1">
                        <div
                          className="highlight-content text-base mb-3 prose dark:prose-invert max-w-none"
                          dangerouslySetInnerHTML={{
                            __html: highlight.html_content || highlight.text,
                          }}
                        />
                        <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
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
                    </div>
                  </div>
                )
              })}
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
    </main>
  )
}

