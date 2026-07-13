// fetch bounded by a timeout. On a connected-but-dead network (Wi-Fi up,
// internet unreachable) the platform fetch can hang for 60s+ — or forever —
// which freezes whatever awaits it: a pin click never reaches its
// offline-queue fallback, and a hung replay fetch wedges the single-flight
// drain (blocking every future sync this page load). The Supabase client
// already bounds its own requests (lib/supabase/client.ts); this is the same
// guarantee for our raw /api/* calls.
//
// Skips the bound on runtimes without AbortSignal.timeout, and respects a
// caller-provided signal.
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000

export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const signal =
    init.signal ??
    (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(timeoutMs)
      : undefined)
  return fetch(input, { ...init, ...(signal ? { signal } : {}) })
}
