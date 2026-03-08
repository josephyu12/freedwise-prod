import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy — Freedwise',
  description: 'Learn how Freedwise handles your data and protects your privacy.',
}

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen" style={{ background: 'var(--background)' }}>
      <div className="container mx-auto px-4 py-10">
        <div className="max-w-3xl mx-auto">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm mb-6 hover:underline"
            style={{ color: 'var(--brand)' }}
          >
            ← Back to Home
          </Link>

          <div className="glass-card p-6 sm:p-10">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>
              Privacy Policy
            </h1>
            <p className="text-sm mb-8" style={{ color: 'var(--text-tertiary)' }}>
              Last updated: March 7, 2026
            </p>

            <div className="legal-content">
              <h2>1. Introduction</h2>
              <p>
                Welcome to Freedwise (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;). This Privacy Policy explains how we collect, use, 
                disclose, and safeguard your information when you use our web application and services 
                (collectively, the &quot;Service&quot;). By using the Service, you agree to the practices described 
                in this policy.
              </p>

              <h2>2. Information We Collect</h2>
              
              <h3>Account Information</h3>
              <p>
                When you create an account, we collect your email address for authentication purposes. 
                We use Supabase as our authentication and database provider.
              </p>

              <h3>User Content</h3>
              <p>
                We store the highlights, notes, and categories you create within the Service. This 
                content is associated with your user account and is used solely to provide the Service 
                to you.
              </p>

              <h3>Third-Party Integration Data</h3>
              <p>
                If you choose to connect your Notion workspace, we store your Notion API key and 
                Page ID. These credentials are used only to sync your highlights with your Notion 
                workspace and are stored securely.
              </p>

              <h3>Usage Data</h3>
              <p>
                We may collect information about how you use the Service, including ratings, review 
                activity, and feature usage, to improve the Service.
              </p>

              <h2>3. How We Use Your Information</h2>
              <p>We use the information we collect to:</p>
              <ul>
                <li>Provide, maintain, and improve the Service</li>
                <li>Authenticate your identity and manage your account</li>
                <li>Sync your highlights with connected third-party services (e.g., Notion)</li>
                <li>Distribute highlights for daily review based on your preferences</li>
                <li>Send you service-related notifications</li>
              </ul>

              <h2>4. Data Storage and Security</h2>
              <p>
                Your data is stored on Supabase infrastructure, which uses industry-standard security 
                measures including encryption at rest and in transit. We implement appropriate technical 
                and organizational measures to protect your personal data against unauthorized access, 
                alteration, disclosure, or destruction.
              </p>

              <h2>5. Data Sharing</h2>
              <p>
                We do not sell, trade, or rent your personal information to third parties. We may share 
                your data only in the following circumstances:
              </p>
              <ul>
                <li><strong>With your consent:</strong> When you connect third-party services like Notion</li>
                <li><strong>Service providers:</strong> With Supabase (database/auth) and Vercel (hosting) to operate the Service</li>
                <li><strong>Legal requirements:</strong> When required by law or to protect our rights</li>
              </ul>

              <h2>6. Your Rights</h2>
              <p>You have the right to:</p>
              <ul>
                <li>Access the personal data we hold about you</li>
                <li>Request correction of inaccurate data</li>
                <li>Request deletion of your data</li>
                <li>Export your data</li>
                <li>Withdraw consent for third-party integrations at any time (via Settings)</li>
              </ul>

              <h2>7. Data Retention</h2>
              <p>
                We retain your data for as long as your account is active. If you delete your account, 
                we will delete your personal data within 30 days, except where retention is required 
                by law.
              </p>

              <h2>8. Cookies</h2>
              <p>
                We use essential cookies for authentication and session management. We do not use 
                tracking cookies or third-party advertising cookies.
              </p>

              <h2>9. Changes to This Policy</h2>
              <p>
                We may update this Privacy Policy from time to time. We will notify you of any 
                changes by posting the new Privacy Policy on this page and updating the 
                &quot;Last updated&quot; date.
              </p>

              <h2>10. Contact Us</h2>
              <p>
                If you have questions about this Privacy Policy or our data practices, please 
                contact us through the application.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
