// Building one highlight's editor content out of two. Shared by the /merge
// page (merging two saved highlights) and the write-time "similar to
// something you already saved" nudge (folding a draft into a saved one).

export type HighlightContent = { text: string; html_content?: string | null }

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Editor-ready HTML for one highlight: its stored rich text, or its plain
// text wrapped into paragraphs.
export function toEditorHtml(h: HighlightContent): string {
  const html = (h.html_content || '').trim()
  if (html) return html
  return h.text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')
}

// Guarantee a block wrapper so two highlights concatenate as separate
// paragraphs instead of running into one line.
export function ensureBlock(html: string): string {
  return /^\s*<(p|div|ul|ol|h[1-6]|blockquote|pre)\b/i.test(html) ? html : `<p>${html}</p>`
}

// `first` then `second`, each as its own block(s). Returns both the HTML the
// editor should show and the plain text the `text` column should hold.
export function combineHighlights(
  first: HighlightContent,
  second: HighlightContent
): { html: string; text: string } {
  return {
    html: ensureBlock(toEditorHtml(first)) + ensureBlock(toEditorHtml(second)),
    text: `${first.text.trim()}\n\n${second.text.trim()}`,
  }
}
