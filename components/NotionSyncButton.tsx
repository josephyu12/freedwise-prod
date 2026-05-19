'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

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

// Each pass processes one queue item server-side so the progress bar can tick
// per-item instead of jumping 0 → 100% after a bulk batch. The loop exits early
// once `data.total === 0`, so this is just an upper safety bound.
const MAX_DRAIN_PASSES = 500

export default function NotionSyncButton() {
  const [status, setStatus] = useState<QueueStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<{ processed: number; failed: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // Treat an in-progress sync like an unsaved change — block tab close,
  // refresh, and in-app navigation until the sync finishes.
  useUnsavedChanges(
    syncing,
    'Notion sync is still running. Leave this page anyway?'
  )

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
    // Refresh immediately when something in this tab enqueues a sync item
    const onQueueUpdated = () => fetchStatus()
    window.addEventListener('focus', onFocus)
    window.addEventListener('notion-sync-queue-updated', onQueueUpdated)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('notion-sync-queue-updated', onQueueUpdated)
    }
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
    <>
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

      {syncing && (
        <SyncModal
          processed={progress?.processed ?? 0}
          failed={progress?.failed ?? 0}
          outstanding={outstanding}
        />
      )}
    </>
  )
}

function SyncModal({
  processed,
  failed,
  outstanding,
}: {
  processed: number
  failed: number
  outstanding: number
}) {
  return (
    <div
      className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notion-sync-title"
    >
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-6 sm:p-8 max-w-md w-full">
        <div className="flex items-center gap-3 mb-3">
          <svg
            className="w-6 h-6 animate-spin text-indigo-600 dark:text-indigo-400 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h5M20 20v-5h-5M20 9A8 8 0 006.34 5.34M4 15a8 8 0 0013.66 3.66"
            />
          </svg>
          <h2
            id="notion-sync-title"
            className="text-xl font-bold text-gray-900 dark:text-white"
          >
            Syncing to Notion…
          </h2>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-300 mb-5">
          Please keep this tab open until the sync finishes. Closing the page or
          navigating away may interrupt items that haven&apos;t been written yet.
        </p>

        <SyncProgressBar
          processed={processed}
          failed={failed}
          outstanding={outstanding}
        />

        <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-4 mb-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">Synced</span>
            <span className="font-semibold text-gray-900 dark:text-white tabular-nums">
              {processed}
            </span>
          </div>
          {failed > 0 && (
            <div className="flex items-baseline justify-between text-sm mt-2">
              <span className="text-gray-500 dark:text-gray-400">Failed</span>
              <span className="font-semibold text-red-600 dark:text-red-400 tabular-nums">
                {failed}
              </span>
            </div>
          )}
          {outstanding > 0 && (
            <div className="flex items-baseline justify-between text-sm mt-2">
              <span className="text-gray-500 dark:text-gray-400">Remaining (approx)</span>
              <span className="font-semibold text-gray-900 dark:text-white tabular-nums">
                {Math.max(0, outstanding - processed - failed)}
              </span>
            </div>
          )}
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          Each Notion write is rate-limited, so a large queue can take a minute or two.
        </p>
      </div>
    </div>
  )
}

function SyncProgressBar({
  processed,
  failed,
  outstanding,
}: {
  processed: number
  failed: number
  outstanding: number
}) {
  const done = processed + failed
  // Ratchet the denominator upward only. The queue can shrink mid-sync when a
  // delete triggers the cancel-pending-add path (removes 1 row, skips enqueue),
  // which would otherwise make the displayed total drop from "0 of 2" to "0 of 1".
  // The modal unmounts between syncs, so the ref resets naturally per run.
  const maxTotalRef = useRef(1)
  const candidate = Math.max(outstanding, done, 1)
  if (candidate > maxTotalRef.current) {
    maxTotalRef.current = candidate
  }
  const total = maxTotalRef.current
  const isIndeterminate = outstanding === 0 && done === 0 && maxTotalRef.current === 1
  const pct = isIndeterminate ? 0 : Math.min(100, Math.round((done / total) * 100))

  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between text-xs text-gray-500 dark:text-gray-400 mb-1.5 tabular-nums">
        <span>{isIndeterminate ? 'Starting…' : `${done} of ${total}`}</span>
        <span>{isIndeterminate ? '' : `${pct}%`}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        {isIndeterminate ? (
          <div className="h-full w-1/3 rounded-full bg-indigo-500 animate-pulse" />
        ) : (
          <div
            className="h-full rounded-full bg-indigo-500 transition-all duration-300 ease-out"
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          />
        )}
      </div>
    </div>
  )
}
