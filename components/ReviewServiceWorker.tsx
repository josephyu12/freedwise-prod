'use client'

import { useEffect } from 'react'

// Registers the weak-signal service worker (public/sw.js) with its scope limited
// to /review, so it can only ever intercept review-route navigations and leaves
// the rest of the app completely untouched. Mounted on the /review page; the SW
// becomes effective from the next /review navigation onward (a SW can't
// intercept the very navigation that registered it).
export default function ReviewServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker
      .register('/sw.js', { scope: '/review' })
      .catch((err) => console.warn('Review service worker registration failed:', err))
  }, [])
  return null
}
