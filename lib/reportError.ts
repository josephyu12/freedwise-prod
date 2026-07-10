// Report a HANDLED error to Sentry (and the console). Most failures in this
// app are caught and degraded gracefully — which also made them invisible in
// production. Sentry's auto-capture only sees UNhandled exceptions, so the
// swallowed paths that matter (offline-replay drops/stalls, sync failures)
// report through this explicitly. Dynamically imported so test runs and
// DSN-less deployments never load the SDK; captureException no-ops without an
// initialized client.
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  console.error(error)
  import('@sentry/nextjs')
    .then((Sentry) => {
      Sentry.captureException(error, context ? { extra: context } : undefined)
    })
    .catch(() => {
      /* SDK unavailable — console.error above already logged it */
    })
}
