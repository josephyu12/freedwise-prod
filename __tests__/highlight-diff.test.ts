import { describe, it, expect } from 'vitest'
import { diffWordsToHtml, getHighlightBlockDiff } from '../lib/highlightDiff'
import {
  blockEditSimilarity,
  blocksMatchForCompare,
  highlightToBlockTexts,
} from '../lib/notionBlocks'

describe('highlightToBlockTexts', () => {
  it('splits plain newline-separated text into blocks', () => {
    expect(highlightToBlockTexts(null, 'First\nSecond')).toEqual(['First', 'Second'])
  })
})

describe('blocksMatchForCompare', () => {
  it('treats punctuation and case differences as equal', () => {
    expect(blocksMatchForCompare('Hello—world', 'hello-world')).toBe(true)
  })
})

describe('blockEditSimilarity', () => {
  it('requires the first normalized word to match and enough leading alignment', () => {
    expect(blockEditSimilarity('The quick brown fox', 'The quick gray fox')).toBeGreaterThan(0)
    expect(blockEditSimilarity('Quick brown', 'The slow brown')).toBe(0)
    expect(blockEditSimilarity('The quick brown', 'The slow brown')).toBe(0)
  })
})

describe('getHighlightBlockDiff', () => {
  it('detects added paragraphs', () => {
    const previousText = 'First bullet\nSecond bullet'
    const currentText = 'First bullet\nSecond bullet\nThird bullet'

    const diff = getHighlightBlockDiff(null, previousText, null, currentText)

    expect(diff.hasPrevious).toBe(true)
    expect(diff.added).toEqual(['Third bullet'])
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)
  })

  it('detects removed paragraphs', () => {
    const previousText = 'Keep me\nRemove me'
    const currentText = 'Keep me'

    const diff = getHighlightBlockDiff(null, previousText, null, currentText)

    expect(diff.removed).toEqual(['Remove me'])
    expect(diff.added).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)
  })

  it('reports no previous snapshot', () => {
    const diff = getHighlightBlockDiff(null, null, null, 'Only version')

    expect(diff.hasPrevious).toBe(false)
  })

  it('handles duplicate bullets via multiset matching', () => {
    const previousText = 'Same\nSame'
    const currentText = 'Same\nSame\nSame'

    const diff = getHighlightBlockDiff(null, previousText, null, currentText)

    expect(diff.added).toEqual(['Same'])
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)
  })

  it('detects in-place word tweaks within a bullet', () => {
    const previousText = 'First unchanged bullet\nSecond bullet with old word\nThird unchanged'
    const currentText = 'First unchanged bullet\nSecond bullet with new word\nThird unchanged'

    const diff = getHighlightBlockDiff(null, previousText, null, currentText)

    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(1)
    expect(diff.modified[0].oldText).toContain('old word')
    expect(diff.modified[0].newText).toContain('new word')
    expect(diff.modified[0].diffHtml).toContain('<del')
    expect(diff.modified[0].diffHtml).toContain('<ins')
  })
})

describe('diffWordsToHtml', () => {
  it('highlights changed words inline', () => {
    const html = diffWordsToHtml('the quick brown fox', 'the slow brown fox')

    expect(html).toContain('<del')
    expect(html).toContain('quick')
    expect(html).toContain('<ins')
    expect(html).toContain('slow')
    expect(html).toContain('brown')
  })
})
