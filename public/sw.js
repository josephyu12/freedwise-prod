// Weak-signal service worker for the review flow.
//
// Two jobs:
//
// 1. AUTO-SWITCH (the original behaviour): when the browser makes a TOP-LEVEL
//    NAVIGATION to /review (a real document load — typed URL, refresh, PWA cold
//    start, external link), it races the network against a 7s timeout. If
//    /review loads in time you get the full page; if it's slower (or fails) it
//    serves a tiny interstitial that hands off to the text-only /review/lite.
//
// 2. OFFLINE LITE (added for offline rating): /review/lite is served
//    network-first with a cache fallback, and immutable build assets
//    (/_next/static/*) are cached cache-first. Together these let the lite page
//    LOAD and HYDRATE with no network at all — its rating island then queues
//    ratings in IndexedDB and replays them on reconnect. A single-user PWA, so
//    caching the user's own page + its chunks is safe.
//
// What it deliberately does NOT do — so an already-loaded page is never yanked
// to lite, no matter the signal:
//   • The auto-switch only handles requests with mode === 'navigate'. In-app
//     client-side navigations (tapping a <Link>) fetch RSC payloads, NOT
//     navigations, so they pass straight through and keep using the loaded SPA.
//   • A service worker can only respond to NEW requests; it cannot reach into a
//     page that's already rendered. A live /review session is therefore immune.
//   • It only special-cases /review, /review/lite, and /_next/static. Every
//     other request — APIs (incl. the rating server action POST), RSC, all
//     other routes — passes through to the network untouched.

const TIMEOUT_MS = 7000
const LITE_CACHE = 'freedwise-lite-v1'
const ASSET_CACHE = 'freedwise-assets-v1'

self.addEventListener('install', () => {
  // Activate this version immediately rather than waiting for all old tabs to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Take control of in-scope clients so the new version is effective right away.
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Only ever touch our own GETs. The rating server-action POST and any other
  // method pass straight through to the network.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Immutable hashed build assets: cache-first so the lite page's JS chunks are
  // available offline (needed for the rating island to hydrate). Not a
  // navigation, so this must be handled before the mode check below.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Below here: only top-level document navigations — never RSC fetches or APIs.
  if (request.mode !== 'navigate') return

  // The text-only page: network-first, fall back to the last cached copy so it
  // still loads with no signal. Pass-through-and-cache; never the interstitial
  // (no redirect loop).
  if (url.pathname === '/review/lite') {
    event.respondWith(liteNavigation(request))
    return
  }

  // Exact /review only. Everything else passes through to the network.
  if (url.pathname !== '/review') return

  event.respondWith(handleReviewNavigation(request))
})

// Cache-first for immutable assets: serve the cached copy if present, otherwise
// fetch, store a clone, and return it.
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response && response.ok) {
    const copy = response.clone()
    caches.open(ASSET_CACHE).then((c) => c.put(request, copy)).catch(() => {})
  }
  return response
}

// Network-first for the lite page: prefer fresh HTML (and refresh the cache),
// but fall back to the last cached copy when offline. If nothing is cached yet,
// let the failure surface (browser's offline page).
async function liteNavigation(request) {
  try {
    const response = await fetch(request)
    if (response && response.ok) {
      const copy = response.clone()
      caches.open(LITE_CACHE).then((c) => c.put('/review/lite', copy)).catch(() => {})
    }
    return response
  } catch (err) {
    const cached = await caches.match('/review/lite')
    if (cached) return cached
    throw err
  }
}

async function handleReviewNavigation(request) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(request, { signal: controller.signal })
    clearTimeout(timer)
    return response
  } catch (err) {
    clearTimeout(timer)
    // Either the 7s timeout aborted the fetch, or the network failed outright.
    // Either way, hand off to the lightweight text-only page.
    return interstitialResponse()
  }
}

function interstitialResponse() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Switching to text-only…</title>
  <!-- No-JS fallback: bounce to lite after 2s if the script below didn't run. -->
  <meta http-equiv="refresh" content="2;url=/review/lite" />
  <style>
    body {
      margin: 0; min-height: 100vh; padding: 24px; box-sizing: border-box;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 16px; text-align: center; color: #374151;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #eff6ff, #e0e7ff);
    }
    .spinner {
      width: 28px; height: 28px; border-radius: 50%;
      border: 3px solid #c7d2fe; border-top-color: #4f46e5;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .msg { font-size: 18px; font-weight: 500; }
    a { color: #2563eb; font-size: 15px; }
    @media (prefers-color-scheme: dark) {
      body { color: #d1d5db; background: linear-gradient(135deg, #111827, #1f2937); }
      a { color: #60a5fa; }
      .spinner { border-color: #374151; border-top-color: #818cf8; }
    }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <div class="msg">Taking a while — switching to text-only…</div>
  <a href="/review/lite">Go now →</a>
  <script>setTimeout(function () { location.replace('/review/lite'); }, 900);</script>
</body>
</html>`
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
