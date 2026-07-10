// Last line of defense before dangerouslySetInnerHTML: strip executable HTML
// (script tags, on* handlers, javascript: URLs) while keeping formatting.
// lib/sanitizeHtml.ts is a FORMATTING cleaner (styles/classes), not a security
// boundary — content reaches the DB from the rich-text editor, pasted HTML,
// and Notion imports, so render output must be sanitized regardless of source.
//
// DOMPurify runs entirely in this browser tab: no network calls, nothing
// leaves the device. During the server prerender there is no DOM to sanitize
// with, but user content is only fetched client-side after mount, so the SSR
// pass never contains user HTML and passing through unchanged there is safe.

import DOMPurify from 'dompurify'

export function sanitizeForRender(html: string): string {
  if (typeof window === 'undefined' || !html) return html
  return DOMPurify.sanitize(html)
}
