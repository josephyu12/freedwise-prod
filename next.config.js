const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Loads instrumentation.ts (Sentry server/edge init) on Next 14.
    instrumentationHook: true,
  },
}

// Sentry is a no-op until NEXT_PUBLIC_SENTRY_DSN is set (create a Sentry
// project, copy its DSN into Vercel env vars). Guarding the wrapper keeps the
// build byte-identical to before when the DSN is absent. Source-map upload
// stays disabled until a SENTRY_AUTH_TOKEN is configured.
module.exports = process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      silent: true,
      telemetry: false,
      disableLogger: true,
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    })
  : nextConfig
