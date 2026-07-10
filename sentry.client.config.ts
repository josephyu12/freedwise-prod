// Client-side Sentry init. Loaded by withSentryConfig (next.config.js) only
// when NEXT_PUBLIC_SENTRY_DSN is set — a complete no-op otherwise.
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Error capture only — no performance-tracing event volume.
  tracesSampleRate: 0,
})
