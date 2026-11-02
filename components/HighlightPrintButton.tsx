'use client'

import { useRef, useState } from 'react'
import { Printer } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { describeHighlightFilters, type HighlightFilters } from '@/lib/highlightFilters'
import { buildHighlightPrintDocument, loadHighlightsForPrint } from '@/lib/highlightPrint'

export default function HighlightPrintButton({ filters, categories, disabled = false }: {
  filters: HighlightFilters
  categories: { id: string; name: string }[]
  disabled?: boolean
}) {
  const busy = useRef(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preparePrint = async () => {
    if (busy.current) return
    setError(null)
    // Open during the click gesture, before auth/fetch, to avoid popup blocking.
    const preview = window.open('', '_blank')
    if (!preview) {
      setError('Allow pop-ups for this site, then try Print / PDF again.')
      return
    }
    preview.opener = null
    preview.document.title = 'Preparing highlights…'
    preview.document.body.textContent = 'Preparing all matching highlights…'
    busy.current = true
    setWorking(true)
    try {
      const rows = await loadHighlightsForPrint(createClient(), filters)
      if (preview.closed) return
      preview.document.open()
      preview.document.write(buildHighlightPrintDocument(rows, describeHighlightFilters(filters, categories)))
      preview.document.close()
      preview.document.getElementById('print-highlights')?.addEventListener('click', () => {
        preview.focus()
        preview.print()
      })
    } catch (err: any) {
      const message = err?.message || 'Could not prepare highlights. Please try again.'
      setError(message)
      if (!preview.closed) preview.document.body.textContent = `Export failed: ${message}. Close this tab and try again from Highlights.`
    } finally {
      busy.current = false
      setWorking(false)
    }
  }

  return <div>
    <button type="button" onClick={preparePrint} disabled={disabled || working}
      className="btn-secondary !rounded-full !py-2 !px-3.5 text-sm disabled:opacity-50"
      title="Print every matching highlight or save them as a PDF">
      <Printer className="w-4 h-4" aria-hidden="true" />
      {working ? 'Preparing…' : 'Print / PDF'}
    </button>
    {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400 max-w-sm">{error}</p>}
  </div>
}
