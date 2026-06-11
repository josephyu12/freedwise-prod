import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import AppHeader from '@/components/AppHeader'
import ServiceWorkerRegistrar from '@/components/ServiceWorkerRegistrar'

const inter = Inter({ subsets: ['latin'], display: 'swap' })
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
        {/*
          Record the browser's IANA timezone in a cookie so server-rendered
          pages (e.g. /review/lite) can compute "today" in the user's local
          time instead of the server's UTC. Runs synchronously while the head
          is parsed — before any client navigation — so the cookie is already
          present on the RSC request for the next page.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{document.cookie='tz='+encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)+';path=/;max-age=31536000;samesite=lax'}catch(e){}",
          }}
        />
      </head>
      <body className={`${inter.className} flex flex-col min-h-screen`}>
        <ServiceWorkerRegistrar />
        <AppHeader />
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
