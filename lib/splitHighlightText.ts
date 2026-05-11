/**
 * Utilities for splitting multi-paragraph highlights into individual paragraph blocks.
 * Used by the review page's interactive split feature.
 */

export interface ParagraphBlock {
  html: string
  text: string
  isListItem?: boolean
  listTag?: 'ul' | 'ol'
}

// Container tags: recurse into children rather than treating as a leaf block
const RECURSE_TAGS = new Set([
  'div', 'blockquote', 'section', 'article', 'main', 'aside',
  'details', 'summary', 'figure', 'figcaption',
])

// Leaf block tags: produce a single block from their innerHTML
const LEAF_BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'])

// Tags to ignore entirely
const SKIP_TAGS = new Set(['br', 'hr', 'script', 'style', 'noscript'])

/**
 * Parse HTML content into individual paragraph blocks using the DOM.
 * Handles nested lists, ordered lists, inline formatting, blockquotes, etc.
 * Each top-level <p>, <h*>, or <li> becomes a separate block.
 * Nested list content is preserved inside its parent <li> block.
 */
export function parseIntoParagraphs(
  htmlContent: string | null | undefined,
  plainText: string
): ParagraphBlock[] {
  const source = (htmlContent || plainText || '').trim()
  if (!source) return []

  // SSR fallback: DOMParser is unavailable on the server
  if (typeof DOMParser === 'undefined') {
    const text = source.replace(/<[^>]*>/g, '').trim()
    return text ? [{ html: source, text }] : []
  }

  // If there are no block-level tags, treat as plain text and split on newlines
  if (!/<(p|div|ul|ol|li|h[1-6]|blockquote|pre|br)\b/i.test(source)) {
    return source
      .split(/\n/)
      .map((line) => {
        const html = line.trim()
        const text = html.replace(/<[^>]*>/g, '').trim()
        return { html, text }
      })
      .filter((b) => b.text.length > 0)
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${source}</body>`, 'text/html')
  const body = doc.body

  const blocks: ParagraphBlock[] = []

  // Flush accumulated inline nodes as a single paragraph block
  function flushInlineBuffer(buffer: ChildNode[]) {
    if (buffer.length === 0) return
    const tmp = doc.createElement('span')
    buffer.forEach((n) => tmp.appendChild(n.cloneNode(true)))
    const html = tmp.innerHTML.trim()
    const text = (tmp.textContent || '').trim()
    if (text) blocks.push({ html, text })
    buffer.length = 0
  }

  function processChildren(parent: Node) {
    const inlineBuffer: ChildNode[] = []

    for (const child of Array.from(parent.childNodes)) {
      // Text node
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.textContent || '').trim()) inlineBuffer.push(child)
        continue
      }

      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      const tag = el.tagName.toLowerCase()

      if (SKIP_TAGS.has(tag)) continue

      if (LEAF_BLOCK_TAGS.has(tag)) {
        flushInlineBuffer(inlineBuffer)
        const text = (el.textContent || '').trim()
        if (text) blocks.push({ html: el.innerHTML, text })
        continue
      }

      if (tag === 'ul' || tag === 'ol') {
        flushInlineBuffer(inlineBuffer)
        // Only iterate direct <li> children — nested <li>s stay inside their parent's innerHTML
        for (const liChild of Array.from(el.childNodes)) {
          if (liChild.nodeType !== Node.ELEMENT_NODE) continue
          const li = liChild as Element
          if (li.tagName.toLowerCase() !== 'li') continue
          const text = (li.textContent || '').trim()
          if (text) {
            blocks.push({
              html: li.innerHTML,
              text,
              isListItem: true,
              listTag: tag as 'ul' | 'ol',
            })
          }
        }
        continue
      }

      if (RECURSE_TAGS.has(tag)) {
        flushInlineBuffer(inlineBuffer)
        processChildren(el)
        continue
      }

      // Inline or unknown element — buffer it
      inlineBuffer.push(child)
    }

    flushInlineBuffer(inlineBuffer)
  }

  processChildren(body)

  return blocks.filter((b) => b.text.length > 0)
}

/**
 * Split rich-text composer output into multiple highlights using blank lines
 * as separators. Mirrors Notion import semantics: a single empty block
 * (a <p>/<div> with no text, even if it contains a <br>) marks a highlight
 * boundary. Consecutive empties collapse — multiple blank lines === one separator.
 *
 * Also normalizes browser contentEditable noise: top-level <div> wrappers (which
 * Chrome emits on every Enter) are unwrapped into clean <p> paragraphs so the
 * stored html_content is semantic, not "testing<div>more</div>".
 *
 * Returns a single-entry array if there are no blank-line separators, so callers
 * can always iterate the result as the list of highlights to create.
 */
export function splitHtmlByBlankLines(
  htmlContent: string | null | undefined,
  plainText: string
): { text: string; html: string }[] {
  const source = (htmlContent || '').trim()
  const fallbackText = (plainText || '').trim()

  if (!source && !fallbackText) return []

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // SSR / no rich block structure: split plain text on blank lines.
  // Wrap each piece in <p> so the stored HTML stays semantic.
  if (typeof DOMParser === 'undefined' || !/<(p|div|ul|ol|li|h[1-6]|blockquote|pre|br)\b/i.test(source)) {
    const text = (source ? source.replace(/<[^>]*>/g, '') : fallbackText).trim()
    const pieces = text.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)
    if (pieces.length === 0) return []
    if (pieces.length === 1) {
      // Preserve any inline formatting (b/i/u/etc.) the user added
      return [{ text: pieces[0], html: source || escapeHtml(pieces[0]) }]
    }
    return pieces.map((t) => ({ text: t, html: `<p>${escapeHtml(t)}</p>` }))
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${source}</body>`, 'text/html')
  const body = doc.body

  const SEPARATOR_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'])
  const LIST_TAGS = new Set(['ul', 'ol'])
  const PRESERVE_TAGS = new Set(['ul', 'ol', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

  type Para = { html: string; text: string; wrapped: boolean }
  const groups: Para[][] = []
  let currentGroup: Para[] = []
  let paraHtml = ''
  let paraText = ''

  const flushPara = () => {
    const text = paraText.replace(/\s+/g, ' ').trim()
    if (text || paraHtml.trim()) {
      currentGroup.push({ html: paraHtml, text, wrapped: false })
    }
    paraHtml = ''
    paraText = ''
  }

  const flushGroup = () => {
    flushPara()
    if (currentGroup.length > 0) groups.push(currentGroup)
    currentGroup = []
  }

  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = node.textContent || ''
      if (txt) {
        paraHtml += escapeHtml(txt)
        paraText += txt
      }
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue

    const el = node as Element
    const tag = el.tagName.toLowerCase()
    const elText = (el.textContent || '').trim()

    if (tag === 'br') {
      paraHtml += '<br>'
      continue
    }

    if (SEPARATOR_TAGS.has(tag)) {
      // Empty block (e.g. <div><br></div>) = highlight separator
      if (elText === '') {
        flushGroup()
        continue
      }
      // Non-empty top-level block: emit as its own paragraph.
      flushPara()
      paraHtml = el.innerHTML
      paraText = el.textContent || ''
      currentGroup.push({ html: paraHtml, text: paraText.replace(/\s+/g, ' ').trim(), wrapped: false })
      paraHtml = ''
      paraText = ''
      continue
    }

    if (LIST_TAGS.has(tag) || PRESERVE_TAGS.has(tag)) {
      flushPara()
      currentGroup.push({
        html: (el as HTMLElement).outerHTML,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        wrapped: true,
      })
      continue
    }

    // Inline element — fold into the current paragraph
    paraHtml += (el as HTMLElement).outerHTML
    paraText += el.textContent || ''
  }
  flushGroup()

  if (groups.length === 0) {
    const text = (body.textContent || '').trim()
    return text ? [{ text, html: `<p>${escapeHtml(text)}</p>` }] : []
  }

  return groups
    .map((paragraphs) => {
      const html = paragraphs
        .map((p) => (p.wrapped ? p.html : `<p>${p.html}</p>`))
        .join('')
      const text = paragraphs.map((p) => p.text).filter(Boolean).join('\n')
      return { html, text }
    })
    .filter((g) => g.text.length > 0)
}

/**
 * Group paragraphs according to where split points are placed.
 * splitPoints is a Set of indices — a split at index `i` means
 * there's a cut between paragraph[i] and paragraph[i+1].
 *
 * Returns grouped highlights with combined html and text.
 * Consecutive list items are wrapped in <ul> or <ol> as appropriate.
 */
export function groupParagraphsByDividers(
  paragraphs: ParagraphBlock[],
  splitPoints: Set<number>
): ParagraphBlock[] {
  if (paragraphs.length === 0) return []

  const groups: ParagraphBlock[] = []
  let currentParts: ParagraphBlock[] = []

  for (let i = 0; i < paragraphs.length; i++) {
    currentParts.push(paragraphs[i])

    if (splitPoints.has(i) || i === paragraphs.length - 1) {
      const htmlPieces: string[] = []
      let liBuffer: ParagraphBlock[] = []

      const flushLiBuffer = () => {
        if (liBuffer.length === 0) return
        const tag = liBuffer[0].listTag || 'ul'
        htmlPieces.push(
          `<${tag}>${liBuffer.map((l) => `<li>${l.html}</li>`).join('')}</${tag}>`
        )
        liBuffer = []
      }

      for (const part of currentParts) {
        if (part.isListItem) {
          // Flush if switching between ul and ol
          if (liBuffer.length > 0 && liBuffer[0].listTag !== part.listTag) flushLiBuffer()
          liBuffer.push(part)
        } else {
          flushLiBuffer()
          htmlPieces.push(`<p>${part.html}</p>`)
        }
      }
      flushLiBuffer()

      groups.push({
        html: htmlPieces.join(''),
        text: currentParts.map((p) => p.text).join('\n'),
      })
      currentParts = []
    }
  }

  return groups
}
