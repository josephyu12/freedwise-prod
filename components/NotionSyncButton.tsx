'use client'

import { useEffect, useState, useCallback } from 'react'

type QueueStatus = {
  pending: number
  processing: number
  failed: number
  readyToRetry: number
}

type SyncResult = {
  processed?: number
  failed?: number
  total?: number
  message?: string
  error?: string
}

const MAX_DRAIN_PASSES = 8

export default function NotionSyncButton() {
  const [status, setStatus] = useState<QueueStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<{ processed: number; failed: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/notion/sync', { method: 'GET' })
      if (!res.ok) return
      const data = (await res.json()) as QueueStatus
      setStatus(data)
    } catch {
      // best-effort
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    // Refresh queue count when the tab regains focus so the badge stays current
    const onFocus = () => fetchStatus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [fetchStatus])

  const drainQueue = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setMessage(null)
    setProgress({ processed: 0, failed: 0 })

    let totalProcessed = 0
    let totalFailed = 0
    let notionConfigured = true

    try {
      for (let i = 0; i < MAX_DRAIN_PASSES; i++) {
        const res = await fetch('/api/notion/sync', { method: 'POST' })
        const data = (await res.json().catch(() => ({}))) as SyncResult

        if (!res.ok) {
          setMessage(data.error || 'Sync failed')
          break
        }

        if (data.message === 'Notion integration not configured') {
          notionConfigured = false
          break
        }

        totalProcessed += data.processed || 0
        totalFailed += data.failed || 0
        setProgress({ processed: totalProcessed, failed: totalFailed })

        // Queue is drained when the API returns nothing new to work on
        if (!data.total || data.total === 0) break
      }

      if (!notionConfigured) {
        setMessage('Connect Notion in Settings first')
      } else if (totalProcessed === 0 && totalFailed === 0) {
        setMessage('Already in sync')
      } else {
        const parts: string[] = []
        if (totalProcessed > 0) parts.push(`${totalProcessed} synced`)
        if (totalFailed > 0) parts.push(`${totalFailed} failed`)
        setMessage(parts.join(' · '))
      }
    } finally {
      setSyncing(false)
      fetchStatus()
      window.setTimeout(() => setMessage(null), 4000)
    }
  }, [syncing, fetchStatus])

  const pending = status?.pending ?? 0
  const processing = status?.processing ?? 0
  const failed = status?.failed ?? 0
  const outstanding = pending + processing + failed
  const hasWork = outstanding > 0

  let label: string
  if (syncing) {
    label = progress
      ? `Syncing… ${progress.processed}${progress.failed > 0 ? ` · ${progress.failed} failed` : ''}`
      : 'Syncing…'
  } else if (message) {
    label = message
  } else if (hasWork) {
    label = `Sync Notion (${outstanding})`
  } else {
    label = 'Sync Notion'
  }

  return (
    <button
      onClick={drainQueue}
      disabled={syncing}
      className={`flex items-center gap-2 px-3.5 py-2 rounded-full transition-all text-sm font-medium ${
        hasWork && !syncing
          ? 'bg-indigo-500 text-white shadow-sm hover:bg-indigo-600'
          : 'btn-secondary !rounded-full !py-2 !px-3.5'
      } disabled:opacity-60 disabled:cursor-wait`}
      title={
        failed > 0
          ? `${pending} pending, ${failed} failed`
          : `${pending} pending`
      }
    >
      <svg
        className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4 4v5h5M20 20v-5h-5M20 9A8 8 0 006.34 5.34M4 15a8 8 0 0013.66 3.66"
        />
      </svg>
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">
        {syncing ? '…' : hasWork ? `Sync (${outstanding})` : 'Sync'}
      </span>
    </button>
  )
}
