/**
 * Bound an online critical-path await with an overall deadline.
 *
 * The per-request 15s abort in lib/supabase/client.ts bounds each fetch, but
 * not auth-js's token refresh loop: with an expired access token (a tab
 * reopened after hours away) on a dead network, auth-js retries the doomed
 * refresh with exponential backoff for up to a full AUTO_REFRESH_TICK (~30s)
 * while holding the auth lock — and every PostgREST call awaits that token
 * before its own fetch (and its 15s bound) even starts. Flipping manual
 * offline mid-hang doesn't help either: the abort makes each attempt fail
 * fast, but auth-js counts an abort as retryable and keeps backing off until
 * the ~30s window closes. A write that gates the UI (rating buttons stay
 * disabled until it settles) must therefore carry its own overall deadline so
 * it can fall into its offline-queue fallback instead of pinning the UI for
 * the whole backoff.
 *
 * The abandoned write keeps running and may still land. That's fine: the
 * queued replay of the same action is idempotent (fixed-value update /
 * onConflict upsert), so double-apply converges on the same row.
 */
export const ONLINE_WRITE_DEADLINE_MS = 8_000

export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not settle within ${ms}ms`)
    this.name = 'DeadlineError'
  }
}

/** Await `work`, but reject with DeadlineError after `ms` so callers can fall
 * back. Accepts thenables (PostgREST builders), not just Promises. */
export function withDeadline<T>(
  work: PromiseLike<T>,
  label: string,
  ms: number = ONLINE_WRITE_DEADLINE_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms)
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
