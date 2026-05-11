// Block-level tags that imply the content is already structured into paragraphs.
// Intentionally excludes <br> — we normalize <br> to `\n` before this check so
// it participates in paragraph splitting like a regular newline.
const HAS_BLOCK_TAG = /<(p|div|ul|ol|li|h[1-6]|blockquote|pre|table)\b/i

// Paragraph-like blocks whose internal `\n` characters should still produce
// paragraph breaks (so a `<p>foo\nbar</p>` renders as two visually-separated
// paragraphs instead of one paragraph with a single line break).
const PARA_BLOCK_SPLIT = /<(p|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi

const BR_TAG = /<br\s*\/?>/gi

/**
 * Build the HTML string for rendering a highlight card.
 *
 * Highlights arrive in inconsistent shapes: plain text with raw `\n`, a single
 * `<p>` (or `<div>`) wrapper with `\n`-separated lines inside, or `<br>`-
 * separated runs from older imports and pasted content. Rendered as-is, all of
 * those collapse paragraphs together. This helper normalizes them so the
 * `.highlight-content p` margin gives Notion-style spacing everywhere.
 */
export function renderHighlightHtml(
  htmlContent: string | null | undefined,
  text: string | null | undefined
): string {
  let source = (htmlContent?.trim() || text?.trim() || '')
  if (!source) return ''

  // Treat <br> like a newline so it participates in paragraph splitting below.
  source = source.replace(BR_TAG, '\n')

  if (!HAS_BLOCK_TAG.test(source)) {
    const paragraphs = source
      .split(/\r?\n+/)
      .map((p) => p.trim())
      .filter(Boolean)

    if (paragraphs.length <= 1) return source
    return paragraphs.map((p) => `<p>${p}</p>`).join('')
  }

  if (!/\n/.test(source)) return source

  return source.replace(PARA_BLOCK_SPLIT, (match, tag, attrs, content) => {
    if (!/\n/.test(content)) return match
    const parts = content
      .split(/\r?\n+/)
      .map((s: string) => s.trim())
      .filter(Boolean)
    if (parts.length <= 1) return match
    return parts.map((p: string) => `<${tag}${attrs}>${p}</${tag}>`).join('')
  })
}
