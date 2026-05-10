// Block-level tags that imply the content is already structured into paragraphs.
const HAS_BLOCK_TAG = /<(p|div|ul|ol|li|h[1-6]|blockquote|pre|table|br)\b/i

/**
 * Build the HTML string for rendering a highlight card.
 *
 * Some highlights are stored as plain text with raw `\n` characters (e.g.
 * legacy entries, or paths that bypass the rich-text editor). When that's
 * passed straight into `dangerouslySetInnerHTML`, the newlines collapse and
 * paragraphs visually run together. This helper:
 *
 *   - Returns content as-is if it already contains block-level tags or <br>.
 *   - Otherwise, splits on blank lines / single newlines and wraps each
 *     paragraph in <p>, so the existing `.prose p` margin gives Notion-style
 *     spacing between paragraphs.
 */
export function renderHighlightHtml(
  htmlContent: string | null | undefined,
  text: string | null | undefined
): string {
  const source = (htmlContent?.trim() || text?.trim() || '')
  if (!source) return ''
  if (HAS_BLOCK_TAG.test(source)) return source

  const paragraphs = source
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean)

  if (paragraphs.length <= 1) return source
  return paragraphs.map((p) => `<p>${p}</p>`).join('')
}
