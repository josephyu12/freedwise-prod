// Block-level tags that imply the content is already structured into paragraphs.
// <br> is intentionally excluded — it's a soft line break, not a paragraph
// boundary, and we now preserve it as a line break rather than promoting it.
const HAS_BLOCK_TAG = /<(p|div|ul|ol|li|h[1-6]|blockquote|pre|table)\b/i

// Paragraph-like blocks. We split their inner content only on BLANK lines
// (two+ newlines = a real paragraph break) and reflow any remaining single
// `\n` (a soft line-wrap) into a space — see reflowParagraph.
const PARA_BLOCK_SPLIT = /<(p|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi

// A blank line: two or more newlines (optionally with horizontal whitespace
// between them). This is the only newline pattern that means "new paragraph".
const BLANK_LINE = /\r?\n[ \t]*(?:\r?\n[ \t]*)+/

// A single soft line-wrap: one newline plus the whitespace hugging it. These
// come from Kindle/Readwise exports that hard-wrap every visual line of the
// source mid-sentence. They are NOT paragraph breaks, so we collapse them to a
// single space to reflow the prose the way the original paragraph reads.
const SOFT_WRAP = /[ \t]*\r?\n[ \t]*/g

const STRUCTURAL_BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table',
])

// Split a chunk into paragraphs on blank lines, reflowing soft wraps within
// each paragraph into spaces. Returns the trimmed, non-empty paragraphs.
function toParagraphs(chunk: string): string[] {
  return chunk
    .split(BLANK_LINE)
    .map((p) => p.replace(SOFT_WRAP, ' ').trim())
    .filter(Boolean)
}

/**
 * Build the HTML string for rendering a highlight card.
 *
 * Highlights arrive in inconsistent shapes: plain text with raw `\n`, a single
 * `<p>` (or `<div>`) wrapper with `\n`-separated lines inside, `<br>`-separated
 * runs, or a mix of loose top-level text next to a sibling `<div>` (browser
 * contentEditable). The tricky part is that a `\n` inside a paragraph is almost
 * always a soft line-wrap from the import source (mid-sentence, one per visual
 * line of the book), not a paragraph break — so promoting each to its own `<p>`
 * scatters a single paragraph into margin-separated fragments. We therefore
 * reflow single `\n` into spaces and only treat blank lines (and real block
 * boundaries) as paragraph breaks, so `.highlight-content p` spacing lands on
 * actual paragraphs.
 */
export function renderHighlightHtml(
  htmlContent: string | null | undefined,
  text: string | null | undefined
): string {
  let source = (htmlContent?.trim() || text?.trim() || '')
  if (!source) return ''

  if (!HAS_BLOCK_TAG.test(source)) {
    const paragraphs = toParagraphs(source)
    if (paragraphs.length === 0) return ''
    // Single paragraph: return it as-is (it may carry inline tags like <br> or
    // <strong>); only wrap in <p> when there's more than one to space.
    if (paragraphs.length === 1) return paragraphs[0]
    return paragraphs.map((p) => `<p>${p}</p>`).join('')
  }

  // First pass: within each paragraph-like block, split on blank lines and
  // reflow soft-wrap newlines. A block with no internal newline is untouched.
  if (/\n/.test(source)) {
    source = source.replace(PARA_BLOCK_SPLIT, (match, tag, attrs, content) => {
      if (!/\n/.test(content)) return match
      const parts = toParagraphs(content)
      if (parts.length === 0) return ''
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
    // Reflow any soft wraps that survived in loose top-level text.
    const trimmed = inlineBuffer.replace(SOFT_WRAP, ' ').trim()
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
