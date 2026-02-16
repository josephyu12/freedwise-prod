'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

// Open this page in Safari (where you're already logged in) to get your
// widget token. Copy it and paste it into the Scriptable widget config.
export default function WidgetAuthPage() {
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading')
  const [widgetToken, setWidgetToken] = useState('')
  const [copied, setCopied] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        setStatus('authenticated')
        // Fetch a signed widget token from the server
        try {
          const res = await fetch('/api/widget-token')
          const data = await res.json()
          if (data.token) {
            setWidgetToken(data.token)
          }
        } catch {
          // ignore
        }
      } else {
        setStatus('unauthenticated')
      }
    }

    init()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session) {
        setStatus('authenticated')
        try {
          const res = await fetch('/api/widget-token')
          const data = await res.json()
          if (data.token) {
            setWidgetToken(data.token)
          }
        } catch {
          // ignore
        }
      }
    })

    return () => subscription.unsubscribe()
  }, [supabase])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(widgetToken)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = widgetToken
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (status === 'loading') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
        <div className="text-xl text-gray-600 dark:text-gray-300">Loading...</div>
      </main>
    )
  }

  if (status === 'unauthenticated') {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-6">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Widget Setup</h1>
          <p className="text-gray-600 dark:text-gray-300 mb-6">
            Log in first, then come back to this page to get your widget token.
          </p>
          <Link
            href="/login"
            className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
          >
            Log In
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-6">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Widget Setup</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          Copy this token and paste it into your Scriptable widget script as the <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded text-xs">WIDGET_TOKEN</code> value.
        </p>

        <div className="relative">
          <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 pr-20 font-mono text-xs break-all text-gray-700 dark:text-gray-300 max-h-24 overflow-y-auto">
            {widgetToken || 'Generating token...'}
          </div>
          <button
            onClick={handleCopy}
            disabled={!widgetToken}
            className="absolute top-3 right-3 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <h3 className="text-sm font-semibold text-blue-800 dark:text-blue-300 mb-2">Setup Steps</h3>
          <ol className="text-xs text-blue-700 dark:text-blue-400 space-y-1 list-decimal list-inside">
            <li>Install Scriptable from the App Store</li>
            <li>Create a new script, paste the widget code</li>
            <li>Replace <code className="bg-blue-100 dark:bg-blue-900/50 px-1 rounded">WIDGET_TOKEN</code> with the token above</li>
            <li>Add a Medium Scriptable widget to your home screen</li>
            <li>Long-press widget &gt; Edit Widget &gt; choose script</li>
          </ol>
        </div>

        <div className="mt-4 text-center">
          <Link
            href="/"
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </main>
  )
}
