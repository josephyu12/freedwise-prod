// Block-level tags that imply the content is already structured into paragraphs.
const HAS_BLOCK_TAG = /<(p|div|ul|ol|li|h[1-6]|blockquote|pre|table|br)\b/i

// Paragraph-like blocks whose internal `\n` characters should still produce
// paragraph breaks (so a `<p>foo\nbar</p>` renders as two visually-separated
// paragraphs instead of one paragraph with a single line break).
const PARA_BLOCK_SPLIT = /<(p|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi

/**
 * Build the HTML string for rendering a highlight card.
 *
 * Some highlights are stored as plain text with raw `\n` characters (e.g.
 * legacy entries, or paths that bypass the rich-text editor). Others are
 * stored as a single `<p>` (or `<div>`) wrapper with `\n`-separated lines
 * inside. When either is passed straight into `dangerouslySetInnerHTML`,
 * the newlines render as a single line break with no paragraph margin, so
 * the visual paragraphs run together. This helper normalizes both cases
 * so the `.highlight-content p` margin gives Notion-style spacing
 * everywhere.
 */
export function renderHighlightHtml(
  htmlContent: string | null | undefined,
  text: string | null | undefined
): string {
  const source = (htmlContent?.trim() || text?.trim() || '')
  if (!source) return ''

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
