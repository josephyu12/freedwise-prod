/**
 * Utilities for splitting multi-paragraph highlights into individual paragraph blocks.
 * Used by the review page's interactive split feature.
 */

export interface ParagraphBlock {
  html: string
  text: string
}

/**
 * Parse HTML content into individual paragraph blocks.
 * Splits on <p>, <br>, <li>, and bare newlines.
 */
export function parseIntoParagraphs(
  htmlContent: string | null | undefined,
  plainText: string
): ParagraphBlock[] {
  const source = htmlContent || plainText || ''
  if (!source.trim()) return []

  // Strategy: split on block-level boundaries
  let fragments: string[]

  // Strip semantic wrapper tags (blockquote, section, etc.) — we only care about content inside
  let preprocessed = source
  preprocessed = preprocessed.replace(/<\/?(blockquote|section|article|header|footer|figure|figcaption|aside|main|details|summary)\b[^>]*>/gi, '')

  // If HTML contains block-level tags, split on those
  if (/<(p|li|br|div|h[1-6])\b/i.test(preprocessed)) {
    // Replace </p>, </li>, </div>, </h1-6> with a delimiter, then split
    let normalized = preprocessed
    // Convert <br> and <br/> to delimiters
    normalized = normalized.replace(/<br\s*\/?>/gi, '\n---SPLIT---\n')
    // Convert closing block tags to delimiters (but keep content)
    normalized = normalized.replace(/<\/(p|div|h[1-6])>/gi, '\n---SPLIT---\n')
    // Convert </li> to delimiter
    normalized = normalized.replace(/<\/li>/gi, '\n---SPLIT---\n')
    // Remove opening block tags
    normalized = normalized.replace(/<(p|div|h[1-6]|li|ul|ol)\b[^>]*>/gi, '')
    // Remove closing <ul> and <ol> (list wrappers)
    normalized = normalized.replace(/<\/(ul|ol)>/gi, '')

    fragments = normalized.split('---SPLIT---')
  } else {
    // Plain text or inline HTML only — split on newlines
    fragments = preprocessed.split(/\n/)
  }

  return fragments
    .map((frag) => {
      const html = frag.trim()
      // Strip HTML tags for plain text version
      const text = html.replace(/<[^>]*>/g, '').trim()
      return { html, text }
    })
    .filter((p) => p.text.length > 0)
}

/**
 * Group paragraphs according to where split points are placed.
 * splitPoints is a Set of indices — a split at index `i` means
 * there's a cut between paragraph[i] and paragraph[i+1].
 *
 * Returns grouped highlights with combined html and text.
 */
export function groupParagraphsByDividers(
  paragraphs: ParagraphBlock[],
  splitPoints: Set<number>
): ParagraphBlock[] {
  if (paragraphs.length === 0) return []

  const groups: ParagraphBlock[] = []
  let currentHtmlParts: string[] = []
  let currentTextParts: string[] = []

  for (let i = 0; i < paragraphs.length; i++) {
    currentHtmlParts.push(paragraphs[i].html)
    currentTextParts.push(paragraphs[i].text)

    // If there's a split after this paragraph, or this is the last one, close the group
    if (splitPoints.has(i) || i === paragraphs.length - 1) {
      groups.push({
        html: currentHtmlParts.map((h) => `<p>${h}</p>`).join(''),
        text: currentTextParts.join('\n'),
      })
      currentHtmlParts = []
      currentTextParts = []
    }
  }

  return groups
}
