// Weak-signal service worker for the review flow.
//
// What it does: when the browser makes a TOP-LEVEL NAVIGATION to /review (a real
// document load — typed URL, refresh, PWA cold start, external link), it races
// the network against a 7s timeout. If /review loads in time, you get the full
// page. If it takes longer than 7s (or the network fails), it serves a tiny
// interstitial that hands off to the text-only /review/lite page.
//
// What it deliberately does NOT do — so an already-loaded page is never yanked
// to lite, no matter the signal:
//   • It only handles requests with mode === 'navigate'. In-app client-side
//     navigations (tapping a <Link>) fetch RSC payloads, NOT navigations, so
//     they pass straight through and keep using the already-loaded SPA.
//   • A service worker can only respond to NEW requests; it cannot reach into a
//     page that's already rendered. A live /review session is therefore immune.
//   • It caches nothing and only touches the exact /review path. Every other
//     request — assets, APIs, RSC, /review/lite itself, all other routes —
//     passes through to the network untouched.
//
// Net effect: the auto-switch can only happen on a cold/fresh load of /review
// that exceeds 7s. If you already have the full page, you keep it.

const TIMEOUT_MS = 7000

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

  // Only top-level document navigations — never RSC fetches, assets, or APIs.
  if (request.mode !== 'navigate') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Exact /review only. /review/lite and everything else pass through, so we
  // never intercept the lite page (no redirect loop) or any other route.
  if (url.pathname !== '/review') return

  event.respondWith(handleReviewNavigation(request))
})

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
