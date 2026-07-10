'use client'

// Root error boundary: reports render crashes to Sentry (no-op without a DSN)
// and shows a recoverable screen instead of a white page. Must render its own
// <html>/<body> because it replaces the root layout when it triggers.
import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body>
        <main
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <h2 style={{ fontSize: '20px', fontWeight: 600 }}>Something went wrong</h2>
          <p style={{ color: '#6b7280', fontSize: '14px' }}>
            The error has been recorded. Reloading usually fixes it.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px',
              borderRadius: '8px',
              border: 'none',
              background: '#2563eb',
              color: 'white',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  )
}
