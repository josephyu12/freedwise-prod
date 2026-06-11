'use client'

import { useEffect } from 'react'

// Registers the offline service worker (public/sw.js) at ROOT scope so it can
// serve every in-app page offline (network-first page shells) plus immutable
// build assets (cache-first) — letting /daily, /review/lite, and the rest load
// and hydrate with no signal, at which point each page's existing IndexedDB
// cache + offline queue takes over.
//
// Mounted once in the root layout so the worker is registered no matter which
// page the user lands on first. The worker special-cases /review (the
// weak-signal auto-switch to /review/lite) and passes every non-GET /
// cross-origin request straight through, so widening the scope doesn't change
// how any of those requests behave.
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => console.warn('Service worker registration failed:', err))

    // Best-effort cleanup: an earlier build registered this same worker under
    // the narrower /review scope. Drop that stale registration so we don't run
    // two workers side by side now that the root scope covers everything. We
    // only ever unregister the /review-scoped one — never the new root ('/').
    navigator.serviceWorker.getRegistrations?.().then((regs) => {
      regs.forEach((r) => {
        try {
          const p = new URL(r.scope).pathname
          if (p === '/review' || p === '/review/') r.unregister()
        } catch {
          /* ignore */
        }
      })
    }).catch(() => {})
  }, [])

  return null
}
