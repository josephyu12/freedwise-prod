'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

// Fired by the header's graduation-cap button (and anywhere else) to replay
// the tutorial. Kept as a window event so the trigger and the modal don't
// need shared React state across the layout tree.
export const OPEN_TUTORIAL_EVENT = 'freedwise:open-tutorial'

// Bump the version suffix to re-show the tutorial to everyone after a
// substantial content change.
const seenKey = (userId: string) => `freedwise-tutorial-seen-v1:${userId}`

interface Step {
  title: string
  icon: React.ReactNode
  body: React.ReactNode
}

function Point({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
      <span className="text-blue-500 dark:text-blue-400 select-none">•</span>
      <p>{children}</p>
    </div>
  )
}

const STEPS: Step[] = [
  {
    title: 'Welcome to Freedwise',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    body: (
      <>
        <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
          Freedwise resurfaces your saved highlights a few at a time, so the ideas you
          collected actually stick instead of gathering dust.
        </p>
        <Point>Save highlights from your books, articles, and notes.</Point>
        <Point>Review a small batch each day and rate how much each one still matters.</Point>
        <Point>Highlights you&apos;ve outgrown fade away automatically.</Point>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          This tour takes about a minute.
        </p>
      </>
    ),
  },
  {
    title: 'Add your highlights',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
      </svg>
    ),
    body: (
      <>
        <Point>
          Add and edit highlights on the <strong>Highlights</strong> page — formatting,
          images, and links are supported.
        </Point>
        <Point>
          Or pull everything in at once from a Notion page via <strong>Import</strong>.
          With Notion sync set up, later edits push back to Notion too.
        </Point>
        <Point>
          New highlights are scheduled onto upcoming days automatically — you don&apos;t
          have to organize anything.
        </Point>
      </>
    ),
  },
  {
    title: 'Review a little every day',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
      </svg>
    ),
    body: (
      <>
        <Point>
          The <strong>Review</strong> page shows today&apos;s batch. Rate each highlight{' '}
          <strong>Low / Med / High</strong> for how valuable it still feels.
        </Point>
        <Point>
          Missed a few days? Unrated highlights from earlier in the cycle appear as
          catch-up, oldest first.
        </Point>
        <Point>
          Feeling ambitious? <strong>Review Ahead</strong> lets you keep going into the
          rest of the cycle.
        </Point>
        <Point>
          The <strong>Daily</strong> calendar tracks progress: green dot = day fully
          rated, yellow = partially.
        </Point>
      </>
    ),
  },
  {
    title: 'Cycles and auto-archive',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
    body: (
      <>
        <Point>
          Every highlight comes up for review <strong>once per cycle</strong> — a
          calendar month by default (changeable in Settings).
        </Point>
        <Point>
          Rate a highlight <strong>Low two cycles in a row</strong> and it&apos;s
          archived automatically — that&apos;s how your reviews stay fresh instead of
          piling up.
        </Point>
        <Point>
          Nothing is lost: an Undo appears when it happens, and you can unarchive
          anytime from Highlights → Show Archived.
        </Point>
      </>
    ),
  },
  {
    title: 'Pins and search',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
      </svg>
    ),
    body: (
      <>
        <Point>
          <strong>Pin</strong> up to 10 favorites to keep them one tap away on the Pins
          page, regardless of the schedule.
        </Point>
        <Point>
          <strong>Search</strong> finds anything across your entire collection,
          including archived highlights.
        </Point>
      </>
    ),
  },
  {
    title: 'Works offline, help is nearby',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5 5 0 017.778 0M12 20h.01M5.05 12.96a10 10 0 0113.9 0M2 8.82a15 15 0 0120 0" />
      </svg>
    ),
    body: (
      <>
        <Point>
          No connection? Keep reviewing — ratings and edits queue on your device and
          sync when you&apos;re back online. The Wi-Fi icon in the header forces
          offline mode on a flaky connection.
        </Point>
        <Point>
          The full rulebook lives on the{' '}
          <Link href="/help" className="text-blue-600 dark:text-blue-400 underline">
            Help
          </Link>{' '}
          page.
        </Point>
        <Point>
          Replay this tour anytime with the graduation-cap icon in the header.
        </Point>
      </>
    ),
  },
]

/**
 * First-run onboarding tour. Auto-opens once per signed-in user (tracked in
 * localStorage per user id, so each account on a shared browser gets its own
 * first-run) and can be replayed via the OPEN_TUTORIAL_EVENT window event —
 * dispatched by the graduation-cap button in AppHeader.
 */
export default function TutorialModal() {
  const [isOpen, setIsOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [userId, setUserId] = useState<string | null>(null)

  // Auto-open for users who haven't seen the tutorial. getSession reads local
  // storage (no network), so this also behaves offline.
  useEffect(() => {
    const supabase = createClient()
    let cancelled = false

    const maybeOpen = (id: string | undefined) => {
      // Never auto-open over the login page (a stale session can linger there)
      if (cancelled || !id || window.location.pathname === '/login') return
      setUserId(id)
      try {
        if (!localStorage.getItem(seenKey(id))) {
          setStep(0)
          setIsOpen(true)
        }
      } catch {
        // Storage unavailable (private mode quota etc.) — skip auto-open
        // rather than re-showing the tutorial on every visit.
      }
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      maybeOpen(session?.user?.id)
    })

    // Catch sign-ins that happen without a full page load (client-side
    // navigation after login), so brand-new accounts see the tour immediately.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN') maybeOpen(session?.user?.id)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  // Replay requests from the header icon
  useEffect(() => {
    const handleOpen = () => {
      setStep(0)
      setIsOpen(true)
    }
    window.addEventListener(OPEN_TUTORIAL_EVENT, handleOpen)
    return () => window.removeEventListener(OPEN_TUTORIAL_EVENT, handleOpen)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    if (userId) {
      try {
        localStorage.setItem(seenKey(userId), new Date().toISOString())
      } catch {}
    }
  }, [userId])

  // Escape closes
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, close])

  // Prevent body scroll while open
  useEffect(() => {
    if (!isOpen) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  if (!isOpen) return null

  const current = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  return (
    <div
      className="fixed inset-0 bg-black/50 dark:bg-black/70 z-50 flex items-center justify-center p-4"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tutorial-title"
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-lg w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shrink-0">
              {current.icon}
            </div>
            <h2 id="tutorial-title" className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white">
              {current.title}
            </h2>
          </div>
          <button
            onClick={close}
            aria-label="Close tutorial"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition shrink-0 ml-3"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 space-y-2.5">
          {current.body}
        </div>

        <div className="flex items-center justify-between gap-3 p-6 pt-5">
          {/* Progress dots */}
          <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                aria-label={`Go to step ${i + 1}`}
                className={`h-2 rounded-full transition-all duration-200 ${
                  i === step
                    ? 'w-5 bg-blue-600 dark:bg-blue-400'
                    : 'w-2 bg-gray-300 dark:bg-gray-600 hover:bg-gray-400 dark:hover:bg-gray-500'
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {isFirst ? (
              <button
                onClick={close}
                className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg transition"
              >
                Skip
              </button>
            ) : (
              <button
                onClick={() => setStep(step - 1)}
                className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
              >
                Back
              </button>
            )}
            {isLast ? (
              <button
                onClick={close}
                className="px-5 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Get started
              </button>
            ) : (
              <button
                onClick={() => setStep(step + 1)}
                className="px-5 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
