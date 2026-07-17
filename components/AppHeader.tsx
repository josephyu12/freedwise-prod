'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import AuthButton from './AuthButton'
import ScrollToTop from './ScrollToTop'
import OfflineModeToggle from './OfflineModeToggle'
import { OPEN_TUTORIAL_EVENT } from './TutorialModal'

// Graduation cap — replays the onboarding tutorial (handled by TutorialModal)
const tutorialIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 14l9-5-9-5-9 5 9 5z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z" />
  </svg>
)

const openTutorial = () => window.dispatchEvent(new CustomEvent(OPEN_TUTORIAL_EVENT))

const NAV_LINKS = [
  { href: '/daily', label: 'Daily', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )},
  { href: '/highlights', label: 'Highlights', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )},
  { href: '/review', label: 'Review', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
    </svg>
  )},
  { href: '/search', label: 'Search', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  )},
  { href: '/web', label: 'Web', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="5" cy="6" r="2" strokeWidth={1.5} />
      <circle cx="19" cy="6" r="2" strokeWidth={1.5} />
      <circle cx="12" cy="18" r="2" strokeWidth={1.5} />
      <path strokeLinecap="round" strokeWidth={1.5} d="M6.7 7.4l4 8.8M17.3 7.4l-4 8.8M7 6h10" />
    </svg>
  )},
  { href: '/pins', label: 'Pins', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
    </svg>
  )},
  { href: '/help', label: 'Help', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )},
]

export default function AppHeader() {
  const pathname = usePathname()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Close mobile menu when route changes
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [pathname])

  // Close mobile menu on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false)
    }
    if (mobileMenuOpen) {
      document.addEventListener('keydown', handleEscape)
    }
    return () => document.removeEventListener('keydown', handleEscape)
  }, [mobileMenuOpen])

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [mobileMenuOpen])

  // Don't show header on login page
  if (pathname === '/login') return null

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  const closeMenu = () => setMobileMenuOpen(false)

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          {/* Logo / Brand */}
          <Link href="/" className="app-header-brand">
            <div className="app-header-logo">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <span className="app-header-brand-text">Freedwise</span>
          </Link>

          {/* Desktop Nav Links */}
          <nav className="app-header-nav">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`app-header-nav-link ${isActive(link.href) ? 'app-header-nav-active' : ''}`}
              >
                {link.icon}
                <span>{link.label}</span>
              </Link>
            ))}
          </nav>

          {/* Right side: ScrollToTop + Auth + Mobile hamburger */}
          <div className="app-header-right">
            <ScrollToTop />
            <button
              onClick={openTutorial}
              aria-label="Replay the tutorial"
              title="Replay the tutorial"
              className="hidden sm:flex items-center justify-center w-9 h-9 rounded-xl border shadow-sm transition-all duration-200 bg-white/80 dark:bg-white/10 backdrop-blur-md border-gray-200/60 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:shadow-md hover:bg-white dark:hover:bg-white/15"
            >
              {tutorialIcon}
            </button>
            <OfflineModeToggle />
            <div className="hidden md:block">
              <AuthButton />
            </div>

            {/* Mobile hamburger */}
            <button
              className="app-header-hamburger"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
            >
              <div className="hamburger-lines">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Menu Overlay — clicking it closes the menu */}
      <div
        className={`mobile-nav-backdrop ${mobileMenuOpen ? 'mobile-nav-backdrop-visible' : ''}`}
        onClick={closeMenu}
        aria-hidden="true"
      />

      {/* Mobile Menu Panel */}
      <div
        ref={panelRef}
        className={`mobile-nav-panel ${mobileMenuOpen ? 'mobile-nav-panel-open' : ''}`}
      >
        {/* Close button inside the panel */}
        <div className="mobile-nav-panel-header">
          <span className="mobile-nav-panel-title">Menu</span>
          <button
            className="mobile-nav-close"
            onClick={closeMenu}
            aria-label="Close navigation menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav className="mobile-nav-links">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`mobile-nav-link ${isActive(link.href) ? 'mobile-nav-link-active' : ''}`}
              onClick={closeMenu}
            >
              <span className="mobile-nav-link-icon">{link.icon}</span>
              <span>{link.label}</span>
            </Link>
          ))}
        </nav>
        <div className="px-1 pt-2">
          <OfflineModeToggle variant="full" />
          <button
            onClick={() => {
              closeMenu()
              openTutorial()
            }}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm rounded-lg transition-colors text-left text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
          >
            {tutorialIcon}
            Replay tutorial
          </button>
        </div>
        <div className="mobile-nav-auth">
          <AuthButton dropdownDirection="up" />
        </div>
      </div>
    </>
  )
}
