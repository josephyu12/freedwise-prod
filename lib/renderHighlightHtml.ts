// Block-level tags that imply the content is already structured into paragraphs.
// Intentionally excludes <br> — we normalize <br> to `\n` before this check so
// it participates in paragraph splitting like a regular newline.
const HAS_BLOCK_TAG = /<(p|div|ul|ol|li|h[1-6]|blockquote|pre|table)\b/i

// Paragraph-like blocks whose internal `\n` characters should still produce
// paragraph breaks (so a `<p>foo\nbar</p>` renders as two visually-separated
// paragraphs instead of one paragraph with a single line break).
const PARA_BLOCK_SPLIT = /<(p|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi

const BR_TAG = /<br\s*\/?>/gi

const STRUCTURAL_BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table',
])

import { sanitizeForRender } from './sanitizeForRender'

/**
 * Build the HTML string for rendering a highlight card.
 *
 * Highlights arrive in inconsistent shapes: plain text with raw `\n`, a single
 * `<p>` (or `<div>`) wrapper with `\n`-separated lines inside, `<br>`-separated
 * runs from older imports, or a mix of loose top-level text next to a sibling
 * `<div>` (browser contentEditable). Rendered as-is, all of those collapse
 * paragraphs together. This helper normalizes them so the
 * `.highlight-content p` margin gives Notion-style spacing everywhere.
 *
 * The result is DOMPurify-sanitized (every caller feeds it straight into
 * dangerouslySetInnerHTML).
 */
export function renderHighlightHtml(
  htmlContent: string | null | undefined,
  text: string | null | undefined
): string {
  return sanitizeForRender(buildHighlightHtml(htmlContent, text))
}

function buildHighlightHtml(
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

  // First pass: split paragraph-like blocks that contain internal `\n`.
  if (/\n/.test(source)) {
    source = source.replace(PARA_BLOCK_SPLIT, (match, tag, attrs, content) => {
      if (!/\n/.test(content)) return match
      const parts = content
        .split(/\r?\n+/)
        .map((s: string) => s.trim())
        .filter(Boolean)
      if (parts.length <= 1) return match
      return parts.map((p: string) => `<${tag}${attrs}>${p}</${tag}>`).join('')
    })
  }

  // Second pass: normalize the top level so loose text nodes and sibling
  // `<div>` blocks become `<p>` blocks. Without this, a payload like
  // `text<div>more</div>` renders as a text run + a div with no consistent
  // paragraph margin between them.
  if (typeof DOMParser === 'undefined') return source

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${source}</body>`, 'text/html')
  const body = doc.body

  const pieces: string[] = []
  let inlineBuffer = ''

  const flushInline = () => {
    const trimmed = inlineBuffer.trim()
    if (trimmed) pieces.push(`<p>${trimmed}</p>`)
    inlineBuffer = ''
  }

  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      inlineBuffer += node.textContent || ''
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue

    const el = node as Element
    const tag = el.tagName.toLowerCase()

    if (tag === 'div') {
      flushInline()
      const inner = el.innerHTML.trim()
      if (inner) pieces.push(`<p>${inner}</p>`)
      continue
    }

    if (STRUCTURAL_BLOCK_TAGS.has(tag)) {
      flushInline()
      pieces.push((el as HTMLElement).outerHTML)
      continue
    }

    // Inline element — accumulate in the inline buffer
    inlineBuffer += (el as HTMLElement).outerHTML
  }
  flushInline()

  return pieces.join('') || source
}
