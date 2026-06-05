'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

const FEATURES = [
  {
    title: 'Capture highlights',
    description:
      'Save quotes, notes, and ideas in seconds with a clean rich-text editor. Paste a passage or jot a thought — it’s kept safe in your library.',
    accent: 'indigo',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    ),
  },
  {
    title: 'Daily review',
    description:
      'Your highlights are automatically distributed into a manageable daily summary, so the things you save actually resurface instead of gathering dust.',
    accent: 'violet',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    ),
  },
  {
    title: 'Quick Review',
    description:
      'Rate highlights one at a time. Your ratings tune how often each one comes back, keeping the most valuable notes top of mind.',
    accent: 'sky',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
    ),
  },
  {
    title: 'Instant search',
    description:
      'Find any highlight in an instant. Search across everything you’ve ever saved and filter by your own categories.',
    accent: 'emerald',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    ),
  },
  {
    title: 'Pin Board & Archives',
    description:
      'Pin the highlights that matter most for quick access, and archive the ones you’re done with — without ever losing them.',
    accent: 'rose',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
    ),
  },
  {
    title: 'iOS lock-screen widget',
    description:
      'Put a fresh highlight right on your iPhone lock screen, so you revisit your best ideas throughout the day — no app to open.',
    accent: 'teal',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
    ),
  },
]

const ACCENT_CLASSES: Record<string, { bg: string; text: string }> = {
  indigo: { bg: 'bg-indigo-50 dark:bg-indigo-500/10', text: 'text-indigo-500' },
  violet: { bg: 'bg-violet-50 dark:bg-violet-500/10', text: 'text-violet-500' },
  sky: { bg: 'bg-sky-50 dark:bg-sky-500/10', text: 'text-sky-500' },
  emerald: { bg: 'bg-emerald-50 dark:bg-emerald-500/10', text: 'text-emerald-500' },
  rose: { bg: 'bg-rose-50 dark:bg-rose-500/10', text: 'text-rose-500' },
  teal: { bg: 'bg-teal-50 dark:bg-teal-500/10', text: 'text-teal-500' },
}

const STEPS = [
  { num: '1', title: 'Save what you want to remember', body: 'Add highlights from your reading, conversations, and ideas.' },
  { num: '2', title: 'We schedule them for review', body: 'Highlights are spread across your days into bite-sized daily summaries.' },
  { num: '3', title: 'Revisit and rate', body: 'Quick reviews and ratings keep your best notes resurfacing over time.' },
]

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const supabase = createClient()

  const handleGoogleLogin = async () => {
    try {
      setLoading(true)
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${location.origin}/auth/callback`,
        },
      })
      if (error) throw error
    } catch (error: any) {
      alert(error.message)
    } finally {
      setLoading(false)
    }
  }

  const SignInButton = () => (
    <button
      onClick={handleGoogleLogin}
      disabled={loading}
      className="w-full sm:w-auto px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium"
    >
      {loading ? (
        'Signing in...'
      ) : (
        <>
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Sign in with Google
        </>
      )}
    </button>
  )

  return (
    <main className="min-h-screen" style={{ background: 'var(--background)' }}>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(60rem 30rem at 50% -10%, var(--brand-surface), transparent)',
          }}
          aria-hidden="true"
        />
        <div className="container mx-auto px-4 pt-16 pb-12 sm:pt-24 sm:pb-16">
          <div className="max-w-2xl mx-auto text-center">
            {/* Logo badge */}
            <div className="flex justify-center mb-6">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg"
                style={{ background: 'var(--brand)' }}
              >
                <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
            </div>

            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              Freedwise
            </h1>
            <p className="mt-4 text-lg sm:text-xl" style={{ color: 'var(--text-secondary)' }}>
              Resurface your highlights in daily summaries.
            </p>
            <p className="mt-3 text-base leading-relaxed max-w-xl mx-auto" style={{ color: 'var(--text-tertiary)' }}>
              Freedwise is a personal highlight manager that helps you save the quotes, notes,
              and ideas worth remembering — then automatically brings them back into a light
              daily review so you actually revisit them. Notes are only useful if you read them.
            </p>

            <div className="mt-8 flex flex-col items-center gap-3">
              <SignInButton />
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                Free to use · Sign in with your Google account
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="container mx-auto px-4 pb-4">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-center text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Everything you can do
          </h2>
          <p className="text-center text-sm mb-8" style={{ color: 'var(--text-tertiary)' }}>
            A complete toolkit for capturing and revisiting what matters.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f) => {
              const accent = ACCENT_CLASSES[f.accent]
              return (
                <div key={f.title} className="glass-card p-5">
                  <div className={`w-11 h-11 rounded-xl ${accent.bg} flex items-center justify-center mb-4`}>
                    <svg className={`w-5 h-5 ${accent.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {f.icon}
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>
                    {f.title}
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {f.description}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="container mx-auto px-4 py-12 sm:py-16">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-center text-2xl font-semibold mb-8" style={{ color: 'var(--text-primary)' }}>
            How it works
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {STEPS.map((s) => (
              <div key={s.num} className="text-center px-2">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-4 font-semibold text-white"
                  style={{ background: 'var(--brand)' }}
                >
                  {s.num}
                </div>
                <h3 className="font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>
                  {s.title}
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Google data usage + sign in */}
      <section className="container mx-auto px-4 pb-20">
        <div className="max-w-2xl mx-auto glass-card p-6 sm:p-8 text-center">
          <h2 className="text-xl font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
            Ready to start?
          </h2>
          <p className="text-sm leading-relaxed mb-6" style={{ color: 'var(--text-secondary)' }}>
            Freedwise uses Google Sign-In only to create and secure your account. We access your
            basic profile (name and email address) to identify you — nothing more. We never read,
            store, or share any other data from your Google account. Learn more in our{' '}
            <Link href="/privacy" className="underline" style={{ color: 'var(--brand)' }}>
              Privacy Policy
            </Link>
            .
          </p>
          <div className="flex justify-center">
            <SignInButton />
          </div>
          <p className="mt-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>
            By signing in, you agree to our{' '}
            <Link href="/terms" className="underline hover:opacity-80" style={{ color: 'var(--brand)' }}>
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="underline hover:opacity-80" style={{ color: 'var(--brand)' }}>
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </section>
    </main>
  )
}
