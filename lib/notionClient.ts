import { Client } from '@notionhq/client'

/**
 * Rate-limit-aware Notion client factory.
 *
 * Notion allows ~3 requests/second per integration token and answers 429
 * (`rate_limited`) with a `Retry-After` header when exceeded. The SDK does not
 * retry, so a bulk sync that fires requests back-to-back turns every 429 into
 * a failed queue item. Instead of sprinkling retry wrappers around every call
 * site, this module injects a custom `fetch` into the SDK that:
 *
 *   1. Throttles outgoing requests per token to stay under the limit, even
 *      when several sync requests run concurrently in the same process.
 *   2. On 429, waits for `Retry-After` (and pushes the token's next slot out
 *      so concurrent requests back off too), then retries transparently.
 *   3. Retries transient 409 conflict / 5xx responses with a short backoff.
 *
 * Every existing `notion.blocks.*` call — including the helpers in
 * notionBlocks.ts — goes through this path with no changes.
 */

// ~2.85 req/s. Notion's documented average is 3 req/s with small bursts
// tolerated; staying a little under avoids 429s in the first place.
const MIN_INTERVAL_MS = 350

const MAX_RATE_LIMIT_RETRIES = 6
// Bound the total time one logical request spends waiting on 429s so it fits
// inside the SDK timeout and the route's maxDuration.
const MAX_RATE_LIMIT_WAIT_MS = 40_000
const DEFAULT_RATE_LIMIT_WAIT_MS = 2_000
const MAX_SINGLE_RATE_LIMIT_WAIT_MS = 30_000

const MAX_TRANSIENT_RETRIES = 3

// Must exceed MAX_RATE_LIMIT_WAIT_MS plus the real request time.
const CLIENT_TIMEOUT_MS = 50_000

type Gate = { nextSlotAt: number }
const gates = new Map<string, Gate>()

function gateFor(key: string): Gate {
  let gate = gates.get(key)
  if (!gate) {
    // Keep the map bounded — tokens are per user, so this only matters for a
    // very long-lived process serving many users.
    if (gates.size > 1000) gates.clear()
    gate = { nextSlotAt: 0 }
    gates.set(key, gate)
  }
  return gate
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Reserve the next send slot for this token and wait until it arrives.
// Reserving before sleeping means concurrent callers queue up in order
// instead of all waking at once.
async function acquireSlot(gate: Gate): Promise<void> {
  const now = Date.now()
  const slot = Math.max(now, gate.nextSlotAt)
  gate.nextSlotAt = slot + MIN_INTERVAL_MS
  const wait = slot - now
  if (wait > 0) await sleep(wait)
}

// Push every pending slot for this token out past the rate-limit window.
function penalize(gate: Gate, ms: number): void {
  gate.nextSlotAt = Math.max(gate.nextSlotAt, Date.now() + ms)
}

function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RATE_LIMIT_WAIT_MS
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, 500), MAX_SINGLE_RATE_LIMIT_WAIT_MS)
  }
  // HTTP-date form
  const at = Date.parse(header)
  if (!Number.isNaN(at)) {
    return Math.min(Math.max(at - Date.now(), 500), MAX_SINGLE_RATE_LIMIT_WAIT_MS)
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS
}

function createThrottledFetch(gateKey: string) {
  const gate = gateFor(gateKey)

  return async function throttledFetch(url: any, init?: any): Promise<any> {
    const method = String(init?.method || 'GET').toUpperCase()
    const requestInit: RequestInit = {
      method,
      headers: init?.headers,
      body: init?.body,
    }

    let rateLimitRetries = 0
    let rateLimitWaited = 0
    let transientRetries = 0

    for (;;) {
      await acquireSlot(gate)

      let response: Response
      try {
        response = await fetch(String(url), requestInit)
      } catch (err) {
        // A dropped connection on a write is ambiguous (Notion may have
        // committed) — let the caller's recovery logic deal with it. Reads
        // are safe to retry.
        if (method === 'GET' && transientRetries < MAX_TRANSIENT_RETRIES) {
          transientRetries++
          await sleep(500 * 2 ** transientRetries)
          continue
        }
        throw err
      }

      if (response.status === 429) {
        const waitMs = parseRetryAfterMs(response.headers.get('retry-after'))
        penalize(gate, waitMs)
        if (
          rateLimitRetries >= MAX_RATE_LIMIT_RETRIES ||
          rateLimitWaited + waitMs > MAX_RATE_LIMIT_WAIT_MS
        ) {
          // Give up — the SDK turns this into a `rate_limited` APIResponseError
          // and the sync route reschedules the item without burning a retry.
          return response
        }
        rateLimitRetries++
        rateLimitWaited += waitMs
        console.warn(`[notion] 429 rate limited on ${method} ${url}; waiting ${waitMs}ms (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`)
        await sleep(waitMs)
        continue
      }

      // 409 conflict_error: Notion asks clients to retry. 5xx: transient.
      if (
        (response.status === 409 || response.status >= 500) &&
        transientRetries < MAX_TRANSIENT_RETRIES
      ) {
        transientRetries++
        await sleep(500 * 2 ** transientRetries)
        continue
      }

      return response
    }
  }
}

/** True if a thrown Notion SDK error is a 429 that survived in-fetch retries. */
export function isNotionRateLimitError(error: any): boolean {
  if (!error) return false
  if (error.code === 'rate_limited' || error.status === 429) return true
  const msg = String(error.message || '').toLowerCase()
  return msg.includes('rate limit') || msg.includes('rate_limited')
}

/**
 * Build a Notion client whose requests are throttled and retried on 429/5xx.
 * Drop-in replacement for `new Client({ auth })`.
 */
export function createNotionClient(apiKey: string): Client {
  return new Client({
    auth: apiKey,
    fetch: createThrottledFetch(apiKey),
    timeoutMs: CLIENT_TIMEOUT_MS,
  })
}
