import { describe, it, expect } from 'vitest'
import { renderHighlightHtml } from '@/lib/renderHighlightHtml'

const countTag = (html: string, tag: string) =>
  (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length

describe('renderHighlightHtml', () => {
  // Regression: the real shape stored for Kindle/Readwise -> Notion imports.
  // Two real paragraphs as <p> blocks, with single `\n` soft line-wraps mid
  // sentence inside each. The bug promoted every soft wrap to its own <p>, so
  // `.highlight-content p` margin scattered one paragraph into blank-line-
  // separated fragments. We expect exactly the two real paragraphs back, with
  // the wraps reflowed into spaces.
  it('reflows mid-sentence soft wraps and keeps real paragraph blocks', () => {
    const html =
      '<p>His interactions went like this: In the first 20 percent of the\n' +
      'interaction, he had a diagnosis written down. He then asks\n' +
      'them about their life.</p>' +
      '<p>I have never seen anyone in healthcare like this. So\n' +
      'many physicians that I know of are indeed Christian.</p>'

    const out = renderHighlightHtml(html, null)

    expect(countTag(out, 'p')).toBe(2)
    expect(out).toContain('the first 20 percent of the interaction, he had')
    expect(out).toContain('healthcare like this. So many physicians')
    // No leftover raw newline that white-space: pre-line would re-expand.
    expect(out).not.toContain('\n')
  })

  it('reflows a single-paragraph soft wrap into a space', () => {
    const out = renderHighlightHtml('<p>foo\nbar</p>', null)
    expect(out).toContain('foo bar')
    expect(countTag(out, 'p')).toBe(1)
  })

  it('treats a blank line (\\n\\n) inside a block as a real paragraph break', () => {
    const out = renderHighlightHtml('<p>foo\n\nbar</p>', null)
    expect(countTag(out, 'p')).toBe(2)
    expect(out).toContain('<p>foo</p>')
    expect(out).toContain('<p>bar</p>')
  })

  it('preserves <br> as a line break rather than reflowing it away', () => {
    const out = renderHighlightHtml('<p>foo<br>bar</p>', null)
    expect(out.toLowerCase()).toContain('<br')
    expect(out).not.toContain('foo bar')
    expect(countTag(out, 'p')).toBe(1)
  })

  it('reflows soft wraps in the plain-text fallback (no html_content)', () => {
    const out = renderHighlightHtml(null, 'alpha\nbeta')
    expect(out).toContain('alpha beta')
    expect(out).not.toContain('\n')
  })
})
