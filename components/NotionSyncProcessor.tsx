'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isEffectivelyOffline, MANUAL_OFFLINE_EVENT } from '@/hooks/useManualOffline'

export default function NotionSyncProcessor() {
  const [isOnline, setIsOnline] = useState(true)
  const isProcessingRef = useRef(false)
  const supabase = createClient()

  const processQueue = useCallback(async () => {
    // Manual offline is treated exactly like a real disconnect: no Notion push.
    if (isProcessingRef.current || isEffectivelyOffline()) return

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
            // Drain more immediately instead of waiting for next interval
            isProcessingRef.current = false
            setTimeout(processQueue, 0)
            return
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
    setIsOnline(!isEffectivelyOffline())

    const handleOnline = () => {
      setIsOnline(!isEffectivelyOffline())
      processQueue()
    }

    const handleOffline = () => {
      setIsOnline(false)
    }

    // Toggling the manual switch off must resume the Notion push immediately,
    // not wait for the next 10s tick — mirrors how the browser 'online' event
    // is handled. Toggling it on flips the indicator off.
    const handleManualChange = () => {
      if (isEffectivelyOffline()) {
        setIsOnline(false)
      } else {
        setIsOnline(true)
        processQueue()
      }
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener(MANUAL_OFFLINE_EVENT, handleManualChange)

    // Process queue once on mount to handle any pending items
    processQueue()

    // Process queue periodically (every 10 seconds) to handle new items
    // This is for Supabase -> Notion sync only, not for importing
    const interval = setInterval(() => {
      if (!isEffectivelyOffline()) {
        processQueue()
      }
    }, 10000) // Check every 10 seconds

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener(MANUAL_OFFLINE_EVENT, handleManualChange)
      clearInterval(interval)
    }
  }, [processQueue])

  return null
}

