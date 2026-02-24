/**
 * Sanitize HTML from the rich text editor by stripping browser-injected noise.
 * Removes inline styles, data-* attributes, class attributes, and empty <span> wrappers.
 * Keeps only semantic formatting: bold, italic, underline, strikethrough, lists, etc.
 */
export function sanitizeHtml(html: string): string {
  // Remove style attributes entirely — our formatting uses semantic tags (b/i/u/s), not inline styles
  let clean = html.replace(/\s*style="[^"]*"/gi, '')
  // Remove data-* attributes (e.g. data-pm-slice from ProseMirror paste)
  clean = clean.replace(/\s*data-[a-z-]+="[^"]*"/gi, '')
  // Remove class attributes that aren't ours
  clean = clean.replace(/\s*class="[^"]*"/gi, '')
  // Collapse any resulting empty attribute lists like <span >
  clean = clean.replace(/<(\w+)\s+>/g, '<$1>')
  // Remove empty <span> wrappers (left behind after stripping style/class)
  clean = clean.replace(/<span>(.*?)<\/span>/gi, '$1')
  return clean
}
