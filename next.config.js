const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Loads instrumentation.ts (Sentry server/edge init) on Next 14.
    instrumentationHook: true,
    serverComponentsExternalPackages: ['@xenova/transformers'],
  },
  webpack: (config, { isServer }) => {
    // transformers.js only ever runs in the browser (lib/clientEmbeddings
    // dynamic-imports it from effects/handlers). Alias out its Node-only
    // deps so webpack never tries to parse native binaries, and keep the
    // whole package off the server bundle. Matches the official
    // transformers.js Next.js client-side setup.
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      'onnxruntime-node$': false,
    }
    if (isServer) {
      config.externals.push('@xenova/transformers')
    }
    return config
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
