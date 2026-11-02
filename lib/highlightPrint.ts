import DOMPurify from 'dompurify'
import type { Highlight } from '@/types/database'
import { filterHighlights, ratingCount, ratingValue, type HighlightFilters } from './highlightFilters'
import { renderHighlightHtml } from './renderHighlightHtml'

// Deliberately excludes vectors, history joins, and private integration fields.
const EXPORT_SELECT = `id, text, html_content, source, author, created_at,
  archived, average_rating, rating_count, resurface_count,
  highlight_categories(category:categories(id, name, color, created_at))`

export async function loadHighlightsForPrint(supabase: any, filters: HighlightFilters): Promise<Highlight[]> {
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) throw authError
  if (!user) throw new Error('Please sign in to export your highlights.')
  const rows: Highlight[] = []
  const size = 1000
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from('highlights')
      .select(EXPORT_SELECT)
      .eq('user_id', user.id)
      .eq('archived', filters.archived)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + size - 1)
    if (error) throw error // Never offer a silently truncated PDF.
    const page = data || []
    rows.push(...page.map((h: any) => ({
      ...h, categories: (h.highlight_categories || []).map((hc: any) => hc.category).filter(Boolean),
    })))
    if (page.length < size) break
  }
  return filterHighlights(rows, filters)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
}

// Browser-only: DOMPurify needs the DOM. No user content is passed to an SSR
// renderer, executable script, CSS, or an external PDF conversion service.
export function buildHighlightPrintDocument(highlights: Highlight[], criteria: string, date = new Date()): string {
  const articles = highlights.map((h, i) => {
    const attribution = [h.author, h.source].filter(Boolean).join(' — ')
    const count = ratingCount(h)
    const metadata = [
      count ? `Average ${ratingValue(h).toFixed(1)}/3 · ${count} rating${count === 1 ? '' : 's'}` : 'Unrated',
      h.categories?.map((c) => c.name).join(', '),
    ].filter(Boolean).join(' · ')
    // Plain text can contain literal < and >; only html_content is markup.
    const content = renderHighlightHtml(h.html_content, escapeHtml(h.text))
    const safeContent = DOMPurify.sanitize(content, {
      ALLOWED_TAGS: ['p', 'br', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'sub', 'sup', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'span'],
      ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan'],
    })
    return `<article><div class="number">${i + 1}</div><div class="content">${safeContent}</div>
      ${attribution ? `<p class="attribution">${escapeHtml(attribution)}</p>` : ''}
      <p class="metadata">${escapeHtml(metadata)}</p></article>`
  }).join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>Freedwise highlights — ${date.toISOString().slice(0, 10)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0 auto; padding: 32px; max-width: 850px; color: #17202a; background: white; font: 12pt/1.6 Georgia, serif; }
      .toolbar { font: 14px/1.5 system-ui, sans-serif; padding: 16px; margin-bottom: 28px; background: #f0f4f8; border-radius: 8px; }
      button { padding: 10px 18px; cursor: pointer; background: #1e40af; color: white; border: 0; border-radius: 6px; font: inherit; }
      h1 { font-size: 26pt; line-height: 1.2; }
      header { border-bottom: 2px solid #17202a; padding-bottom: 16px; margin-bottom: 24px; }
      header p, .metadata, .number { font: 10pt/1.5 system-ui, sans-serif; color: #4b5563; }
      article { margin: 0 0 24px; padding: 0 0 20px; border-bottom: 1px solid #d1d5db; break-inside: avoid; page-break-inside: avoid; overflow-wrap: anywhere; }
      .number { margin-bottom: 8px; }
      .content p { margin: 0 0 .8em; }
      .content > :last-child { margin-bottom: 0; }
      .content h1, .content h2, .content h3 { font-size: 16pt; }
      .content blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid #9ca3af; }
      pre { white-space: pre-wrap; } table { width: 100%; border-collapse: collapse; } td, th { border: 1px solid #9ca3af; padding: 6px; }
      a { color: inherit; text-decoration: underline; } .attribution { font-style: italic; margin-bottom: 6px; }
      .metadata { margin-bottom: 0; } p { orphans: 3; widows: 3; }
      @page { margin: 18mm; }
      @media print { body { padding: 0; max-width: none; } .toolbar { display: none; } }
    </style></head><body>
    <div class="toolbar"><button id="print-highlights" type="button">Print / Save as PDF</button>
      <p>Choose “Save as PDF” in the print dialog. All matching highlights are included, across every page. For a clean document, turn off browser headers and footers.</p></div>
    <header><h1>Highlights</h1><p>${highlights.length} highlight${highlights.length === 1 ? '' : 's'} · ${escapeHtml(date.toLocaleDateString())}</p>
      <p>${escapeHtml(criteria)}</p></header>
    ${articles || '<p>No highlights match these filters.</p>'}
    </body></html>`
}
