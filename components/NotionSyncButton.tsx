'use client'

import { useEffect, useState, useCallback } from 'react'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { createClient } from '@/lib/supabase/client'
import { setNotionManualDrainActive } from '@/lib/notionSyncQueue'

type QueueStatus = {
  pending: number
  processing: number
  failed: number
  readyToRetry: number
}

type SyncResult = {
  processed?: number
  failed?: number
  rateLimited?: number
  total?: number
  // Set when nothing is ready yet but items are sitting in a backoff /
  // rate-limit cool-down. The drain loop waits for them rather than exiting.
  waiting?: number
  nextRetryAt?: string | null
  message?: string
  error?: string
}

// Each pass processes one queue item server-side so the progress bar can tick
// per-item instead of jumping 0 → 100% after a bulk batch. The loop exits early
// once the queue is empty, so this is just an upper safety bound.
const MAX_DRAIN_PASSES = 1000
// Longest single pause while waiting for throttled items to become ready.
const MAX_COOLDOWN_WAIT_MS = 30_000
const MIN_COOLDOWN_WAIT_MS = 1_000
// If the earliest retry is further out than this (deep exponential backoff on
// a genuinely broken item), stop the drain and let the background processor
// pick it up later rather than holding the modal open for minutes.
const MAX_DEFER_WAIT_MS = 60_000

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms))

// Progress is derived from queue-state snapshots, NOT from per-pass tallies.
// A pass that fails and is retried would otherwise be counted on every retry,
// so "done" outgrew the queue and the bar sat at 100% while the total kept
// climbing. Here: total = size of the work set (pending+processing) at start,
// ratcheted up if items are enqueued mid-sync; done = items that left the work
// set; failed = items that became permanently failed during this run.
type SyncProgress = {
  total: number
  synced: number
  failed: number
  remaining: number
}

export default function NotionSyncButton() {
  const [status, setStatus] = useState<QueueStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  // Non-null while the drain loop is paused for a Notion rate-limit cool-down.
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // null = still checking, false = Notion sync off (render nothing), true = on.
  // When Notion sync isn't enabled there's nothing to sync, so the whole button
  // is hidden and the rest of the app works exactly the same without it.
  const [notionEnabled, setNotionEnabled] = useState<boolean | null>(null)

  // Treat an in-progress sync like an unsaved change — block tab close,
  // refresh, and in-app navigation until the sync finishes.
  useUnsavedChanges(
    syncing,
    'Notion sync is still running. Leave this page anyway?'
  )

  const readStatus = useCallback(async (): Promise<QueueStatus | null> => {
    try {
      const res = await fetch('/api/notion/sync', { method: 'GET' })
      if (!res.ok) return null
      return (await res.json()) as QueueStatus
    } catch {
      return null
    }
  }, [])

  const fetchStatus = useCallback(async () => {
    const data = await readStatus()
    if (data) setStatus(data)
  }, [readStatus])

  // Decide whether to show the button at all based on the user's Notion setting.
  useEffect(() => {
    let cancelled = false
    const checkEnabled = async () => {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          if (!cancelled) setNotionEnabled(false)
          return
        }
        const { data } = await supabase
          .from('user_notion_settings')
          .select('enabled')
          .eq('user_id', user.id)
          .maybeSingle()
        if (!cancelled) setNotionEnabled(!!(data as { enabled?: boolean } | null)?.enabled)
      } catch {
        if (!cancelled) setNotionEnabled(false)
      }
    }
    checkEnabled()
    return () => { cancelled = true }
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
    setNotionManualDrainActive(true)
    setMessage(null)
    setCooldownUntil(null)

    // Baseline snapshot. Work set = pending + processing. Rows already in
    // permanent 'failed' are excluded: the route never picks them up.
    const start = await readStatus()
    const baseFailed = start?.failed ?? 0
    let total = start ? start.pending + start.processing : 0
    let current: SyncProgress = { total, synced: 0, failed: 0, remaining: total }
    setProgress(current)

    const refreshProgress = async () => {
      const s = await readStatus()
      if (!s) return
      const work = s.pending + s.processing
      // Items enqueued mid-sync enlarge the work set; ratchet the total so
      // "done" never moves backwards.
      const doneSoFar = current.synced + current.failed
      total = Math.max(total, work + doneSoFar)
      const done = Math.max(0, total - work)
      const failed = Math.max(0, s.failed - baseFailed)
      current = { total, synced: Math.max(0, done - failed), failed, remaining: work }
      setProgress(current)
      setStatus(s)
    }

    let notionConfigured = true
    let deferred = 0

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

        await refreshProgress()

        if (!data.total || data.total === 0) {
          // Nothing ready. If items are only waiting out a backoff /
          // rate-limit cool-down, pause until the earliest one is due and
          // keep going; otherwise the queue is drained.
          if (data.waiting && data.waiting > 0) {
            const dueIn = data.nextRetryAt
              ? new Date(data.nextRetryAt).getTime() - Date.now()
              : MIN_COOLDOWN_WAIT_MS
            if (dueIn > MAX_DEFER_WAIT_MS) {
              deferred = data.waiting
              break
            }
            const waitMs = Math.min(
              Math.max(dueIn + 250, MIN_COOLDOWN_WAIT_MS),
              MAX_COOLDOWN_WAIT_MS
            )
            setCooldownUntil(Date.now() + waitMs)
            await sleep(waitMs)
            setCooldownUntil(null)
            continue
          }
          break
        }

        // A rate-limited pass did no work; brief pause before the next item
        // so the loop itself doesn't contribute to the pressure.
        if (!data.processed && !data.failed && data.rateLimited) {
          await sleep(MIN_COOLDOWN_WAIT_MS)
        }
      }

      if (!notionConfigured) {
        setMessage('Connect Notion in Settings first')
      } else if (current.synced === 0 && current.failed === 0 && deferred === 0) {
        setMessage('Already in sync')
      } else {
        const parts: string[] = []
        if (current.synced > 0) parts.push(`${current.synced} synced`)
        if (current.failed > 0) parts.push(`${current.failed} failed`)
        if (deferred > 0) parts.push(`${deferred} retrying later`)
        setMessage(parts.join(' · '))
      }
    } finally {
      setNotionManualDrainActive(false)
      setSyncing(false)
      setCooldownUntil(null)
      fetchStatus()
      window.setTimeout(() => setMessage(null), 4000)
    }
  }, [syncing, fetchStatus, readStatus])

  // Make sure the background processor is released if this unmounts mid-drain.
  useEffect(() => () => setNotionManualDrainActive(false), [])

  const pending = status?.pending ?? 0
  const processing = status?.processing ?? 0
  const failed = status?.failed ?? 0
  const outstanding = pending + processing + failed
  const hasWork = outstanding > 0

  let label: string
  if (syncing) {
    label = progress
      ? `Syncing… ${progress.synced}/${progress.total}${progress.failed > 0 ? ` · ${progress.failed} failed` : ''}`
      : 'Syncing…'
  } else if (message) {
    label = message
  } else if (hasWork) {
    label = `Sync Notion (${outstanding})`
  } else {
    label = 'Sync Notion'
  }

  // Notion sync is off (or we're still checking) — render nothing. The button
  // only appears once we confirm the user has Notion sync enabled.
  if (notionEnabled !== true) return null

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
          progress={progress}
          cooldownUntil={cooldownUntil}
        />
      )}
    </>
  )
}

function SyncModal({
  progress,
  cooldownUntil,
}: {
  progress: SyncProgress | null
  cooldownUntil: number | null
}) {
  const synced = progress?.synced ?? 0
  const failed = progress?.failed ?? 0
  const remaining = progress?.remaining ?? 0
  // Tick once a second while paused so the countdown stays live.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (cooldownUntil === null) return
    const id = window.setInterval(() => forceTick(n => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [cooldownUntil])
  const cooldownSeconds =
    cooldownUntil !== null ? Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)) : null

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

        <SyncProgressBar progress={progress} />

        <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-4 mb-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">Synced</span>
            <span className="font-semibold text-gray-900 dark:text-white tabular-nums">
              {synced}
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
          <div className="flex items-baseline justify-between text-sm mt-2">
            <span className="text-gray-500 dark:text-gray-400">Remaining</span>
            <span className="font-semibold text-gray-900 dark:text-white tabular-nums">
              {remaining}
            </span>
          </div>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          {cooldownSeconds !== null
            ? `Notion asked us to slow down — resuming in ${cooldownSeconds}s. Nothing has failed; items are just waiting their turn.`
            : 'Notion allows about 3 requests per second, so a large queue can take several minutes.'}
        </p>
      </div>
    </div>
  )
}

function SyncProgressBar({ progress }: { progress: SyncProgress | null }) {
  // The total is already ratcheted (upward only) by the drain loop, and
  // "done" is derived from the queue shrinking rather than from pass counts,
  // so it can never exceed the total.
  const total = progress?.total ?? 0
  const done = Math.min(total, (progress?.synced ?? 0) + (progress?.failed ?? 0))
  const isIndeterminate = !progress || total === 0
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
