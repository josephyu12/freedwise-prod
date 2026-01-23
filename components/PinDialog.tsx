'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { X } from 'lucide-react'

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

interface PinDialogProps {
  isOpen: boolean
  onClose: () => void
  onSelectRemove: (highlightId: string) => Promise<void>
  onCancel: () => void
}

export default function PinDialog({ isOpen, onClose, onSelectRemove, onCancel }: PinDialogProps) {
  const [pinnedHighlights, setPinnedHighlights] = useState<PinnedHighlight[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const loadPinnedHighlights = useCallback(async () => {
    try {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

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
      setPinnedHighlights(data || [])
    } catch (error) {
      console.error('Error loading pinned highlights:', error)
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    if (isOpen) {
      loadPinnedHighlights()
    }
  }, [isOpen, loadPinnedHighlights])

  const handleRemove = async (highlightId: string) => {
    await onSelectRemove(highlightId)
    await loadPinnedHighlights()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            Pin Board is Full (10/10)
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <p className="text-gray-600 dark:text-gray-300 mb-4">
            Please remove a highlight from your pin board to add a new one:
          </p>

          {loading ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              Loading pinned highlights...
            </div>
          ) : pinnedHighlights.length === 0 ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              No pinned highlights found
            </div>
          ) : (
            <div className="space-y-3">
              {pinnedHighlights.map((pin) => {
                const highlight = pin.highlights
                if (!highlight) return null

                const text = highlight.html_content 
                  ? highlight.html_content.replace(/<[^>]*>/g, '').substring(0, 200)
                  : highlight.text.substring(0, 200)

                return (
                  <div
                    key={pin.id}
                    className="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg border border-gray-200 dark:border-gray-600"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-900 dark:text-gray-100 line-clamp-3">
                          {text}
                          {highlight.text.length > 200 && '...'}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Pinned {new Date(pin.pinned_at).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        onClick={() => handleRemove(highlight.id)}
                        className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm font-medium whitespace-nowrap"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

