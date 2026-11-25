import type { Metadata } from 'next'
import Link from 'next/link'
import DemoButton from '@/components/DemoButton'

export const metadata: Metadata = {
  title: 'Try the Freedwise demo',
  description: 'Rate, search, and organize sample highlights in a private Freedwise workspace.',
}

export default function DemoPage() {
  const demoEnabled = process.env.NEXT_PUBLIC_DEMO_ENABLED === 'true'

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="glass-card w-full max-w-lg p-8 text-center sm:p-12">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl" style={{ color: 'var(--text-primary)' }}>
          Try Freedwise
        </h1>
        <p className="mt-4 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {demoEnabled
            ? 'Rate your first highlight in Quick Review, then explore a sample library with saved notes, categories, and pins. No sign-up needed.'
            : 'The demo is currently unavailable.'}
        </p>
        {demoEnabled && (
          <div className="mt-6 flex justify-center">
            <DemoButton className="btn-primary !text-base" />
          </div>
        )}
        <Link href="/login" className="mt-6 inline-block text-sm underline" style={{ color: 'var(--brand)' }}>
          Sign in to your account
        </Link>
      </section>
    </main>
  )
}
