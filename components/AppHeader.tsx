'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import AuthButton from './AuthButton'
import ScrollToTop from './ScrollToTop'

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
  { href: '/search', label: 'Search', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  )},
  { href: '/pins', label: 'Pins', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
    </svg>
  )},
  { href: '/archives', label: 'Archives', icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
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
        <div className="mobile-nav-auth">
          <AuthButton />
        </div>
      </div>
    </>
  )
}
