import Link from 'next/link'

export default function AboutPage() {
  return (
    <main className="min-h-screen" style={{ background: 'var(--background)' }}>
      <div className="container mx-auto px-4 py-10">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-8" style={{ color: 'var(--text-primary)' }}>
            About
          </h1>

          <div className="glass-card p-6 sm:p-8 space-y-8">
            <div>
              <h2 className="text-xl font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
                Project Philosophy
              </h2>
              <p className="leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                This project was created with the belief that notes are only useful if often read, 
                and through this system notes are automatically distributed for easy daily review,
                encouraging sustainable habits of both note-taking and note-reviewing. 
              </p>
            </div>

            <div className="pt-6" style={{ borderTop: '1px solid var(--border)' }}>
              <h2 className="text-xl font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
                Legal
              </h2>
              <div className="flex gap-4">
                <Link href="/privacy" className="text-sm font-medium hover:underline" style={{ color: 'var(--brand)' }}>
                  Privacy Policy
                </Link>
                <Link href="/terms" className="text-sm font-medium hover:underline" style={{ color: 'var(--brand)' }}>
                  Terms of Service
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
