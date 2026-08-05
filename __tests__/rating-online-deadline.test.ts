/**
 * Regression test for the ONLINE rating lag after a long-idle tab.
 *
 * Commit 4dec9c8 fixed the offline branch: enqueueOfflineAction no longer
 * waits on auth. But the online branch of the rating handlers still awaited
 * supabase.from(...).update() bare — and every PostgREST call first awaits an
 * access token. Reopening Safari after hours away leaves the token expired;
 * on a dead network (before the user flips manual offline mode, while
 * isOnline is still true) auth-js retries the doomed refresh with exponential
 * backoff for up to a full AUTO_REFRESH_TICK (~30s) holding the auth lock.
 * The 15s per-fetch abort never fires because the postgrest fetch hasn't even
 * started. Result: rating buttons grayed out for ~30s on the first tap.
 *
 * The online critical writes are now wrapped in withDeadline(), which rejects
 * after ONLINE_WRITE_DEADLINE_MS so the handlers fall into their existing
 * offline-queue fallback. These tests pin the helper's guarantee: a write
 * that never settles (the doomed-refresh shape) is bounded, real settlements
 * pass through untouched, and PostgREST thenables are accepted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { withDeadline, DeadlineError, ONLINE_WRITE_DEADLINE_MS } from '@/lib/withDeadline'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('withDeadline — bounds the online rating write', () => {
  it('rejects a never-settling write at the deadline (doomed token refresh)', async () => {
    // Exactly how the write behaves while auth-js retries an offline refresh:
    // the promise just never settles.
    const doomed = withDeadline(new Promise(() => {}), 'rate-review write')
    const outcome = expect(doomed).rejects.toThrow(DeadlineError)

    await vi.advanceTimersByTimeAsync(ONLINE_WRITE_DEADLINE_MS)
    await outcome
  })

  it('keeps the deadline well under the ~30s auth-js refresh backoff', () => {
    // The whole point: the UI lock must release long before auth-js gives up.
    expect(ONLINE_WRITE_DEADLINE_MS).toBeLessThan(15_000)
  })

  it('passes a resolution through untouched before the deadline', async () => {
    const result = withDeadline(Promise.resolve({ error: null }), 'rate-review write')
    await expect(result).resolves.toEqual({ error: null })
  })

  it('propagates the underlying rejection unchanged (checked-error paths intact)', async () => {
    const boom = new Error('network dead')
    const result = withDeadline(Promise.reject(boom), 'rate-daily write')
    await expect(result).rejects.toBe(boom)
  })

  it('accepts a thenable, not just a Promise (PostgREST builders are thenables)', async () => {
    const builderLike: PromiseLike<string> = {
      then: (onFulfilled) => Promise.resolve('row').then(onFulfilled),
    }
    await expect(withDeadline(builderLike, 'rate-daily write')).resolves.toBe('row')
  })

  it('ignores a late settlement after the deadline without unhandled rejection', async () => {
    let settle!: (v: string) => void
    const slow = new Promise<string>((resolve) => {
      settle = resolve
    })
    const bounded = withDeadline(slow, 'rate-review write')
    const outcome = expect(bounded).rejects.toThrow(DeadlineError)

    await vi.advanceTimersByTimeAsync(ONLINE_WRITE_DEADLINE_MS)
    await outcome

    // The abandoned write landing later must be a no-op for the caller —
    // replay of the queued action is idempotent, so double-apply is fine.
    settle('late')
    await vi.runAllTimersAsync()
  })
})
