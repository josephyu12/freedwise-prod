'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// This page is loaded inside Scriptable's WebView to obtain auth tokens.
// It displays the session JSON so the widget script can read it.
export default function WidgetAuthPage() {
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading')
  const [sessionJson, setSessionJson] = useState('')
  const supabase = createClient()

  useEffect(() => {
    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        setStatus('authenticated')
        // Expose tokens in a hidden element for WebView to read
        setSessionJson(JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        }))
      } else {
        setStatus('unauthenticated')
      }
    }

    getSession()

    // Listen for auth state changes (user logs in via this page)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        setStatus('authenticated')
        setSessionJson(JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        }))
      }
    })

    return () => subscription.unsubscribe()
  }, [supabase])

  if (status === 'loading') {
    return (
      <div style={{ padding: 20, fontFamily: 'system-ui' }}>
        <p>Loading...</p>
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return (
      <div style={{ padding: 20, fontFamily: 'system-ui' }}>
        <h2 style={{ marginBottom: 16 }}>Widget Setup</h2>
        <p style={{ marginBottom: 12 }}>You need to log in first.</p>
        <a
          href="/login"
          style={{
            display: 'inline-block',
            padding: '12px 24px',
            background: '#3b82f6',
            color: 'white',
            borderRadius: 8,
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          Log In
        </a>
      </div>
    )
  }

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui' }}>
      <h2 style={{ marginBottom: 8 }}>Widget Connected</h2>
      <p style={{ color: '#22c55e', fontWeight: 600 }}>AUTHENTICATED</p>
      {/* Hidden element that Scriptable WebView reads via JavaScript */}
      <div id="widget-session" style={{ display: 'none' }}>{sessionJson}</div>
    </div>
  )
}
