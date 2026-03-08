import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service — Freedwise',
  description: 'Read the Freedwise Terms of Service.',
}

export default function TermsOfServicePage() {
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
              Terms of Service
            </h1>
            <p className="text-sm mb-8" style={{ color: 'var(--text-tertiary)' }}>
              Last updated: March 7, 2026
            </p>

            <div className="legal-content">
              <h2>1. Acceptance of Terms</h2>
              <p>
                By accessing or using Freedwise (the &quot;Service&quot;), you agree to be bound by these 
                Terms of Service (&quot;Terms&quot;). If you do not agree to these Terms, please do not use 
                the Service.
              </p>

              <h2>2. Description of Service</h2>
              <p>
                Freedwise is a personal highlight management tool that helps you save, organize, 
                and review your notes and highlights through daily summaries. The Service may also 
                integrate with third-party services such as Notion for data synchronization.
              </p>

              <h2>3. User Accounts</h2>
              <p>
                To use the Service, you must create an account. You are responsible for:
              </p>
              <ul>
                <li>Maintaining the confidentiality of your account credentials</li>
                <li>All activities that occur under your account</li>
                <li>Notifying us immediately of any unauthorized use</li>
              </ul>

              <h2>4. User Content</h2>
              <p>
                You retain all ownership rights to the content you create, upload, or store 
                through the Service (&quot;User Content&quot;). By using the Service, you grant us a 
                limited license to store, process, and display your User Content solely for 
                the purpose of providing the Service to you.
              </p>
              <p>
                You are solely responsible for your User Content and represent that you have 
                all necessary rights to the content you submit.
              </p>

              <h2>5. Acceptable Use</h2>
              <p>You agree not to:</p>
              <ul>
                <li>Use the Service for any unlawful purpose</li>
                <li>Attempt to gain unauthorized access to the Service or its systems</li>
                <li>Interfere with or disrupt the Service or servers</li>
                <li>Reverse engineer, decompile, or disassemble any aspect of the Service</li>
                <li>Use the Service to store or transmit malicious code</li>
                <li>Share your account credentials with third parties</li>
              </ul>

              <h2>6. Third-Party Integrations</h2>
              <p>
                The Service may allow you to connect third-party services (e.g., Notion). 
                These integrations are optional and subject to the respective third-party&apos;s 
                terms of service. We are not responsible for the practices of third-party 
                services.
              </p>

              <h2>7. Availability and Modifications</h2>
              <p>
                We strive to keep the Service available at all times but do not guarantee 
                uninterrupted access. We reserve the right to modify, suspend, or discontinue 
                the Service (or any part thereof) at any time, with or without notice.
              </p>

              <h2>8. Limitation of Liability</h2>
              <p>
                To the maximum extent permitted by law, Freedwise and its creators shall not 
                be liable for any indirect, incidental, special, consequential, or punitive 
                damages resulting from your use of or inability to use the Service, including 
                but not limited to loss of data, loss of profits, or business interruption.
              </p>

              <h2>9. Disclaimer of Warranties</h2>
              <p>
                The Service is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any 
                kind, either express or implied. We do not warrant that the Service will be 
                error-free, secure, or uninterrupted.
              </p>

              <h2>10. Termination</h2>
              <p>
                You may terminate your account at any time by contacting us. We reserve the 
                right to terminate or suspend your account if you violate these Terms. Upon 
                termination, your right to use the Service will cease immediately.
              </p>

              <h2>11. Changes to Terms</h2>
              <p>
                We may update these Terms from time to time. We will notify you of material 
                changes by posting the updated Terms on this page and updating the 
                &quot;Last updated&quot; date. Continued use of the Service after changes constitutes 
                acceptance of the new Terms.
              </p>

              <h2>12. Governing Law</h2>
              <p>
                These Terms shall be governed by and construed in accordance with the laws 
                of the United States, without regard to conflict of law principles.
              </p>

              <h2>13. Contact</h2>
              <p>
                If you have questions about these Terms, please contact us through the 
                application.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
