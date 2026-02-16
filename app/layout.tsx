import type { Metadata } from 'next'
import './globals.css'
import AuthButton from '@/components/AuthButton'
import ScrollToTop from '@/components/ScrollToTop'
import NotionSyncProcessor from '@/components/NotionSyncProcessor'

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
        <meta name="theme-color" content="#3b82f6" />
      </head>
      <body>
        <div className="fixed top-2 right-2 sm:top-4 sm:right-4 z-50 flex items-center gap-2">
          <ScrollToTop />
          <AuthButton />
        </div>
        <NotionSyncProcessor />
        {children}
      </body>
    </html>
  )
}

