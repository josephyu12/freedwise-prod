import type { Metadata } from 'next'
import './globals.css'
import AuthButton from '@/components/AuthButton'
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
      <body>
        <div className="fixed top-2 right-2 sm:top-4 sm:right-4 z-50">
          <AuthButton />
        </div>
        <NotionSyncProcessor />
        {children}
      </body>
    </html>
  )
}

