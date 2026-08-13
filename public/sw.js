// App-wide offline service worker (root scope).
//
// Two jobs:
//
// 1. OFFLINE PAGE SHELLS: every in-app navigation (/daily, /review,
//    /highlights, …) is served network-first with a cache fallback. Online you
//    always get fresh HTML (and the cache is refreshed); offline you get the
//    last cached shell so the page LOADS at all. Only pages you actually open
//    get cached — nothing is pre-fetched — so this adds no extra data transfer.
//    Once a shell loads, each page's own client logic takes over (e.g. /daily
//    reads the selected day from its per-date IndexedDB cache and queues writes
//    for replay).
//
// 2. OFFLINE HYDRATION: immutable build assets (/_next/static/*) are cached
//    cache-first so a page's JS chunks are present offline and can hydrate.
//
// What it deliberately does NOT do:
//   • It only ever touches same-origin GETs. Non-GET (incl. the rating server
//     action POST, all mutations) and cross-origin (Supabase) pass straight
//     through to the network.
//   • Page caching only handles mode === 'navigate'. In-app client-side
//     navigations fetch RSC payloads, NOT navigations, so they pass through and
//     keep using the already-loaded SPA. A live session is never yanked.

const PAGE_CACHE = 'freedwise-pages-v2'
const ASSET_CACHE = 'freedwise-assets-v1'
const CURRENT_CACHES = [PAGE_CACHE, ASSET_CACHE]

self.addEventListener('install', () => {
  // Activate this version immediately rather than waiting for all old tabs to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop any of our caches that aren't the current versions — old renamed
      // caches and, on a future version bump, the previous generation. Scoped
      // to our own 'freedwise-' prefix so we never touch another origin's
      // caches. Without this the asset cache in particular would accumulate
      // every deploy's immutable chunks forever.
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith('freedwise-') && !CURRENT_CACHES.includes(k))
          .map((k) => caches.delete(k))
      )
      // Take control of in-scope clients so the new version is effective now.
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Only ever touch our own GETs. The rating server-action POST and any other
  // method pass straight through to the network.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Immutable hashed build assets: cache-first so JS chunks are
  // available offline and can hydrate. Not a navigation, so this must be
  // handled before the mode check below.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Below here: only top-level document navigations — never RSC fetches or APIs.
  if (request.mode !== 'navigate') return

  // Every in-app page: network-first with a cache fallback so it loads
  // offline. Keyed by pathname so each page is cached once and reused
  // regardless of query string.
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
