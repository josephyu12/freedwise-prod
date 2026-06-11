'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'
import { getPendingActions, removeAction, incrementActionAttempts } from '@/lib/offlineStore'
import { rateOne } from './actions'
import OfflineBanner from '@/components/OfflineBanner'

// Drop an action after this many failed replays so one permanently-failing
// ("poison") action — e.g. a truly expired session or a highlight deleted on
// another device — can't block the rest of the queue forever. The count only
// rises on real attempts (we only replay while online), so 5 means it failed
// across several separate online sessions, not a single weak-signal blip.
const MAX_REPLAY_ATTEMPTS = 5

// Offline status banner + replay engine for the text-only review page.
//
// When the connection returns, it drains the IndexedDB queue of rate-review
// actions (those enqueued by RateButtons while offline) by re-running them
// through the same server action the online path uses, then refreshes the route
// so the server-rendered list reflects the now-persisted ratings. Only handles
// rate-review — any other queued types (edit/split/etc. from /review or /daily)
// are left for those pages to process.
export default function LiteOfflineSync() {
  const { isOnline } = useOfflineStatus()
  const router = useRouter()
  const [pending, setPending] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const inFlight = useRef(false)

  const countPending = async () => {
    try {
      const actions = await getPendingActions()
      setPending(actions.filter((a) => a.type === 'rate-review').length)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (!isOnline) {
      countPending()
      return
    }

    // Guard the mount race: useOfflineStatus seeds isOnline=true for the first
    // render before its heartbeat corrects it, so bail if the browser already
    // knows we're offline — otherwise we'd "replay" against a dead network and
    // removeAction() (IndexedDB, works offline) would silently drop the rating.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      countPending()
      return
    }

    const run = async () => {
      // Single-flight: a flapping connection can re-fire this effect while a
      // prior replay is still awaiting the server.
      if (inFlight.current) return
      inFlight.current = true
      try {
        const actions = (await getPendingActions()).filter(
          (a) => a.type === 'rate-review'
        )
        setPending(actions.length)
        if (actions.length === 0) return

        setSyncing(true)
        let synced = false
        for (const action of actions) {
          try {
            const { summaryHighlightId, highlightId, rating, today } = action.params
            await rateOne({
              summaryHighlightId,
              highlightId,
              rating,
              summaryDate: today,
            })
            await removeAction(action.id!)
            synced = true
            setPending((n) => Math.max(0, n - 1))
          } catch {
            // Could be a transient network drop mid-replay or a permanently
            // poison action. Bump its attempt count: drop it once it has failed
            // enough times (so it can't wedge the queue), otherwise stop and
            // retry the whole batch later — don't inflate the others' counts on
            // what's probably just a connectivity blip.
            let attempts = MAX_REPLAY_ATTEMPTS
            try {
              attempts = await incrementActionAttempts(action.id!)
            } catch {
              /* ignore */
            }
            if (attempts >= MAX_REPLAY_ATTEMPTS) {
              await removeAction(action.id!).catch(() => {})
              setPending((n) => Math.max(0, n - 1))
              continue
            }
            break
          }
        }
        setSyncing(false)
        if (synced) router.refresh()
      } finally {
        inFlight.current = false
      }
    }
    run()
  }, [isOnline, router])

  return (
    <>
      <OfflineBanner isOnline={isOnline} isSyncing={syncing} pendingCount={pending} />
      {!isOnline && pending > 0 && (
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          {pending} rating{pending === 1 ? '' : 's'} saved on this device — will sync when you reconnect.
        </p>
      )}
    </>
  )
}
