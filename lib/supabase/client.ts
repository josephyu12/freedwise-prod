import { createBrowserClient } from '@supabase/ssr'
import { Database } from '@/types/database'
import { readManualOffline, MANUAL_OFFLINE_EVENT } from '@/hooks/useManualOffline'

// One AbortController shared by every in-flight Supabase request, aborted the
// moment the user flips manual offline mode ON. Without this, a write that's
// mid-flight when the connection dies keeps the UI locked for the full 15s
// timeout below even after the user explicitly goes offline — the rating
// buttons sit grayed out until the timeout finally trips the offline-queue
// fallback. Aborting settles those requests instantly, so flipping the switch
// takes effect immediately: hung writes fall straight into their offline-queue
// catch paths and the replay drain stalls out right away (clearing the
// "Syncing…" banner). Going back online just drops the aborted controller; the
// next request lazily creates a live one.
let offlineAbort: AbortController | null = null
let offlineListenerInstalled = false

function manualOfflineSignal(): AbortSignal | undefined {
  if (typeof window === 'undefined' || typeof AbortController === 'undefined') return undefined
  if (!offlineListenerInstalled) {
    offlineListenerInstalled = true
    window.addEventListener(MANUAL_OFFLINE_EVENT, () => {
      if (readManualOffline()) offlineAbort?.abort()
      else offlineAbort = null
    })
  }
  if (!offlineAbort) {
    offlineAbort = new AbortController()
    // Already offline when the first request of this page load fires: reject it
    // immediately rather than letting it hit a network we're meant to ignore.
    if (readManualOffline()) offlineAbort.abort()
  }
  return offlineAbort.signal
}

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        // Bound every request: on a dead-but-connected network the platform
        // fetch can hang for 60s+, freezing a rating/edit before the checked
        // error finally falls through to the offline queue. 15s covers slow
        // real connections while keeping the failure path responsive. Respect
        // a caller-provided signal; skip on browsers without AbortSignal.timeout.
        // Every request additionally aborts the moment manual offline mode
        // turns on (see manualOfflineSignal above).
        fetch: (input, init) => {
          const signals: AbortSignal[] = []
          if (init?.signal) {
            signals.push(init.signal)
          } else if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
            signals.push(AbortSignal.timeout(15_000))
          }
          const offline = manualOfflineSignal()
          if (offline) signals.push(offline)

          if (signals.length <= 1) return fetch(input, { ...init, signal: signals[0] })

          // Combine manually rather than with AbortSignal.any (not available in
          // every runtime we support): abort when EITHER source aborts, and
          // detach the listeners once the request settles so the long-lived
          // offline signal doesn't accumulate one listener per request.
          const ctrl = new AbortController()
          const onAbort = () => ctrl.abort()
          for (const s of signals) {
            if (s.aborted) {
              ctrl.abort()
              break
            }
            s.addEventListener('abort', onAbort)
          }
          const cleanup = () => signals.forEach((s) => s.removeEventListener('abort', onAbort))
          return fetch(input, { ...init, signal: ctrl.signal }).finally(cleanup)
        },
      },
    }
  )
}

