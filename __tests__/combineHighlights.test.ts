import { describe, it, expect } from 'vitest'
import { combineHighlights, toEditorHtml, ensureBlock } from '@/lib/combineHighlights'

describe('toEditorHtml', () => {
  it('keeps stored rich text', () => {
    expect(toEditorHtml({ text: 'plain', html_content: '<p>rich</p>' })).toBe('<p>rich</p>')
  })

  it('wraps plain text paragraphs and escapes HTML', () => {
    expect(toEditorHtml({ text: 'a < b\n\nc' })).toBe('<p>a &lt; b</p><p>c</p>')
  })
})

describe('ensureBlock', () => {
  it('leaves block-level HTML alone', () => {
    expect(ensureBlock('<p>hi</p>')).toBe('<p>hi</p>')
    expect(ensureBlock('<ul><li>x</li></ul>')).toBe('<ul><li>x</li></ul>')
  })

  it('wraps bare markup so it concatenates as a paragraph', () => {
    expect(ensureBlock('<b>hi</b>')).toBe('<p><b>hi</b></p>')
  })
})

describe('combineHighlights', () => {
  it('joins two highlights as separate paragraphs', () => {
    expect(combineHighlights({ text: 'first' }, { text: 'second' })).toEqual({
      html: '<p>first</p><p>second</p>',
      text: 'first\n\nsecond',
    })
  })

  it('preserves each side’s stored HTML', () => {
    const out = combineHighlights(
      { text: 'a', html_content: '<p><b>a</b></p>' },
      { text: 'b', html_content: '<p>b</p>' }
    )
    expect(out.html).toBe('<p><b>a</b></p><p>b</p>')
    expect(out.text).toBe('a\n\nb')
  })
})
