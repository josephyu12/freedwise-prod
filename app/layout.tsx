import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import AuthButton from '@/components/AuthButton'

const inter = Inter({ subsets: ['latin'], display: 'swap' })
import ScrollToTop from '@/components/ScrollToTop'
import NotionSyncProcessor from '@/components/NotionSyncProcessor'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Freedwise',
  description: 'Resurface your highlights in daily summaries',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Freedwise',
  },
  icons: {
    apple: '/apple-touch-icon.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#6366f1" />
      </head>
      <body className={`${inter.className} flex flex-col min-h-screen`}>
        <div className="fixed top-3 right-3 sm:top-4 sm:right-4 z-50 flex items-center gap-2">
          <ScrollToTop />
          <AuthButton />
        </div>
        <NotionSyncProcessor />
        <div className="flex-1">
          {children}
        </div>
        <footer className="app-footer py-6 px-4 mt-auto">
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs">© {new Date().getFullYear()} Freedwise. All rights reserved.</p>
            <nav className="flex items-center gap-4 text-xs">
              <Link href="/privacy">Privacy Policy</Link>
              <Link href="/terms">Terms of Service</Link>
              <Link href="/about">About</Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  )
}
