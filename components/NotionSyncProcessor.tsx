'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isEffectivelyOffline, MANUAL_OFFLINE_EVENT } from '@/hooks/useManualOffline'
import { notionSyncReadyFilter } from '@/lib/notionSyncQueue'
import { fetchWithTimeout } from '@/lib/fetchWithTimeout'

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

      // Same readiness filter the POST route processes with — if the two ever
      // disagree, an item only THIS check matches triggers a pointless POST
      // every 10s forever (previously: failed items with retry_count 5..19).
      const now = new Date().toISOString()
      const staleCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString()
      const { data: queueItems, error } = await (supabase
        .from('notion_sync_queue') as any)
        .select('id')
        .eq('user_id', user.id)
        .or(notionSyncReadyFilter(now, staleCutoff))
        .limit(1)

      if (error) {
        console.warn('Error checking queue:', error)
        isProcessingRef.current = false
        return
      }

      // Only process if there are pending items. Bounded generously (the route
      // pushes a batch to Notion, which can be slow) — but bounded, because a
      // hung fetch on a dead-but-connected network would hold isProcessingRef
      // forever and permanently stop this page load's Notion pushes.
      if (queueItems && queueItems.length > 0) {
        const response = await fetchWithTimeout(
          '/api/notion/sync',
          { method: 'POST' },
          60_000
        )

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

    // Realtime: queue changes (the enqueue trigger's INSERTs, retries flipping
    // back to pending) arrive as pushed events over the already-open websocket
    // — no more polling every 10 seconds from every tab. Requires
    // migration_notion_realtime.sql; postgres_changes respects RLS so only this
    // user's rows produce events.
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false
    ;(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user || cancelled) return
        channel = supabase
          .channel('notion-sync-queue-changes')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'notion_sync_queue', filter: `user_id=eq.${user.id}` },
            () => {
              if (!isEffectivelyOffline()) processQueue()
            }
          )
          .subscribe()
      } catch {
        // Subscription failed — the safety-net interval below still drains.
      }
    })()

    // Slow safety net for missed events / dropped subscriptions (was every 10s).
    const SAFETY_POLL_MS = 5 * 60 * 1000
    const interval = setInterval(() => {
      if (!isEffectivelyOffline()) {
        processQueue()
      }
    }, SAFETY_POLL_MS)

    return () => {
      cancelled = true
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener(MANUAL_OFFLINE_EVENT, handleManualChange)
      if (channel) supabase.removeChannel(channel)
      clearInterval(interval)
    }
  }, [processQueue, supabase])

  return null
}

