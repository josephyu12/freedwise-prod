// App-wide offline service worker (root scope).
//
// Three jobs:
//
// 1. AUTO-SWITCH (the original behaviour): when the browser makes a TOP-LEVEL
//    NAVIGATION to /review (a real document load — typed URL, refresh, PWA cold
//    start, external link), it races the network against a 7s timeout. If
//    /review loads in time you get the full page; if it's slower (or fails) it
//    serves a tiny interstitial that hands off to the text-only /review/lite.
//    /review is deliberately NOT cached — offline it degrades to lite by design.
//
// 2. OFFLINE PAGE SHELLS: every OTHER in-app navigation (/daily, /review/lite,
//    /highlights, …) is served network-first with a cache fallback. Online you
//    always get fresh HTML (and the cache is refreshed); offline you get the
//    last cached shell so the page LOADS at all. Only pages you actually open
//    get cached — nothing is pre-fetched — so this adds no extra data transfer.
//    Once a shell loads, each page's own client logic takes over (e.g. /daily
//    reads the selected day from its per-date IndexedDB cache and queues writes
//    for replay).
//
// 3. OFFLINE HYDRATION: immutable build assets (/_next/static/*) are cached
//    cache-first so a page's JS chunks are present offline and can hydrate.
//
// What it deliberately does NOT do:
//   • It only ever touches same-origin GETs. Non-GET (incl. the rating server
//     action POST, all mutations) and cross-origin (Supabase) pass straight
//     through to the network.
//   • Page caching only handles mode === 'navigate'. In-app client-side
//     navigations fetch RSC payloads, NOT navigations, so they pass through and
//     keep using the already-loaded SPA. A live session is never yanked.

const TIMEOUT_MS = 7000
const PAGE_CACHE = 'freedwise-pages-v1'
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

  // /review keeps its weak-signal auto-switch (race the network, hand off to
  // lite on slow/no signal) and is never cached.
  if (url.pathname === '/review') {
    event.respondWith(handleReviewNavigation(request))
    return
  }

  // Every other in-app page: network-first with a cache fallback so it loads
  // offline. Keyed by pathname (e.g. /daily's selected day is client state, not
  // in the URL), so each page is cached once and reused regardless of query.
  event.respondWith(networkFirstPage(request, url.pathname))
})

// Cache-first for build assets: serve the cached copy if present, otherwise
// fetch, store a clone, and return it.
//
// Only caches responses Next marks `immutable` (content-hashed production
// assets, served with `cache-control: ...immutable`). This is deliberate: in
// `next dev` the chunks under /_next/static/ are NOT immutable and change on
// every edit, so caching them would serve stale code and break HMR on /review.
// Skipping the cache for non-immutable responses means dev always hits the
// network here — identical to the old pass-through behaviour — while production
// still gets offline-capable assets.
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  const immutable = (response.headers.get('cache-control') || '').includes('immutable')
  if (response && response.ok && immutable) {
    const copy = response.clone()
    caches.open(ASSET_CACHE).then((c) => c.put(request, copy)).catch(() => {})
  }
  return response
}

// Network-first for an in-app page: prefer fresh HTML (and refresh the cache),
// but fall back to the last cached copy when offline. Cached under `cacheKey`
// (the pathname) so a page is stored once and matched regardless of query
// string. If nothing is cached yet, let the failure surface (browser's offline
// page).
async function networkFirstPage(request, cacheKey) {
  try {
    const response = await fetch(request)
    if (response && response.ok) {
      const copy = response.clone()
      caches.open(PAGE_CACHE).then((c) => c.put(cacheKey, copy)).catch(() => {})
    }
    return response
  } catch (err) {
    const cached = await caches.match(cacheKey)
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
