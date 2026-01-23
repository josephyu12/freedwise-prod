'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function NotionSyncProcessor() {
  const [isOnline, setIsOnline] = useState(true)
  const isProcessingRef = useRef(false)
  const supabase = createClient()

  const processQueue = useCallback(async () => {
    if (isProcessingRef.current || !navigator.onLine) return

    isProcessingRef.current = true

    try {
      // Check database directly for pending items
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        isProcessingRef.current = false
        return
      }

      const now = new Date().toISOString()
      const { data: queueItems, error } = await (supabase
        .from('notion_sync_queue') as any)
        .select('id')
        .eq('user_id', user.id)
        .or(`and(status.eq.pending,retry_count.lt.5),and(status.eq.failed,retry_count.lt.20,or(next_retry_at.is.null,next_retry_at.lte.${now}))`)
        .limit(1)

      if (error) {
        console.warn('Error checking queue:', error)
        isProcessingRef.current = false
        return
      }

      // Only process if there are pending items
      if (queueItems && queueItems.length > 0) {
        const response = await fetch('/api/notion/sync', {
          method: 'POST',
        })

        if (response.ok) {
          const data = await response.json()
          if (data.processed > 0) {
            console.log(`Processed ${data.processed} Notion sync items`)
          }
        }
      }
    } catch (err) {
      console.warn('Failed to process Notion sync queue:', err)
    } finally {
      isProcessingRef.current = false
    }
  }, [supabase])

  useEffect(() => {
    setIsOnline(navigator.onLine)

    const handleOnline = () => {
      setIsOnline(true)
      processQueue()
    }

    const handleOffline = () => {
      setIsOnline(false)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Process queue once on mount to handle any pending items
    processQueue()

    // Process queue periodically (every 10 seconds) to handle new items
    // This is for Supabase -> Notion sync only, not for importing
    const interval = setInterval(() => {
      if (navigator.onLine) {
        processQueue()
      }
    }, 10000) // Check every 10 seconds

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      clearInterval(interval)
    }
  }, [processQueue])

  return null
}

