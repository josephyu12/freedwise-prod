import { describe, it, expect } from 'vitest'
import {
  tokenize,
  buildWordDocs,
  wordSimilarity,
  meaningSimilarity,
  pairScore,
  buildEdges,
  parseEmbedding,
  GraphNodeInput,
} from '@/lib/graphEdges'

const vec = (values: number[]): Float32Array => {
  // L2-normalize like real embeddings, so dot == cosine
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1
  return Float32Array.from(values.map((v) => v / norm))
}

describe('tokenize', () => {
  it('lowercases, strips HTML, drops stopwords and short words', () => {
    expect(tokenize('<b>The</b> Grace of God is sufficient')).toEqual([
      'grace', 'god', 'sufficient',
    ])
  })

  it('trims plurals without mangling roots (old stemmer regression)', () => {
    // The removed stemmer mapped created->creat, creation->crea so
    // inflections never matched each other. Plural-only trimming keeps
    // "creates"=="create" and leaves other forms intact but stable.
    expect(tokenize('creates')).toEqual(['create'])
    expect(tokenize('create')).toEqual(['create'])
    expect(tokenize('grass')).toEqual(['grass']) // -ss is not a plural
  })
})

describe('wordSimilarity', () => {
  it('scores shared rare words above shared common words', () => {
    const texts = [
      'perseverance builds character',
      'perseverance builds hope',
      'character builds hope',
      'love builds patience',
      'love builds kindness',
      'love builds joy',
    ]
    const docs = buildWordDocs(texts)
    // "perseverance" (rare) shared vs "builds"-only overlap
    const rareShared = wordSimilarity(docs[0], docs[1])
    const commonShared = wordSimilarity(docs[3], docs[0])
    expect(rareShared).toBeGreaterThan(commonShared)
  })

  it('returns 0 with no overlap or empty docs', () => {
    const docs = buildWordDocs(['alpha beta', 'gamma delta', ''])
    expect(wordSimilarity(docs[0], docs[1])).toBe(0)
    expect(wordSimilarity(docs[0], docs[2])).toBe(0)
  })

  it('is symmetric', () => {
    const docs = buildWordDocs(['faith moves mountains today', 'mountains of faith'])
    expect(wordSimilarity(docs[0], docs[1])).toBeCloseTo(wordSimilarity(docs[1], docs[0]))
  })
})

describe('meaningSimilarity', () => {
  it('maps the sub-floor cosine range to 0 and identity to 1', () => {
    const a = vec([1, 0, 0])
    expect(meaningSimilarity(a, a)).toBeCloseTo(1)
    const orthogonal = vec([0, 1, 0])
    expect(meaningSimilarity(a, orthogonal)).toBe(0)
  })
})

describe('pairScore', () => {
  it('falls back to pure word overlap when an embedding is missing', () => {
    const docs = buildWordDocs(['grace abounds', 'grace abounds', 'unrelated words here'])
    const withEmb = pairScore(vec([1, 0]), vec([1, 0]), docs[0], docs[1])
    const noEmb = pairScore(null, vec([1, 0]), docs[0], docs[1])
    expect(noEmb).toBeCloseTo(wordSimilarity(docs[0], docs[1]))
    expect(withEmb).toBeGreaterThan(0.69) // 0.7 * 1.0 meaning + word share
  })
})

describe('buildEdges', () => {
  it('connects similar pairs, skips dissimilar ones, dedupes, respects topK', () => {
    const texts = [
      'the discipline of daily prayer strengthens the soul',
      'daily prayer discipline makes the soul strong',
      'stock markets fell sharply on tuesday afternoon trading',
      'markets dropped in tuesday afternoon trading sessions',
    ]
    const nodes: GraphNodeInput[] = [
      { index: 0, text: texts[0], embedding: vec([1, 0.05, 0]) },
      { index: 1, text: texts[1], embedding: vec([1, 0, 0.05]) },
      { index: 2, text: texts[2], embedding: vec([0, 1, 0.05]) },
      { index: 3, text: texts[3], embedding: vec([0.05, 1, 0]) },
    ]
    const edges = buildEdges(nodes, texts, { topK: 2, minScore: 0.3 })

    const has = (a: number, b: number) =>
      edges.some((e) => e.s === Math.min(a, b) && e.t === Math.max(a, b))
    expect(has(0, 1)).toBe(true) // prayer pair
    expect(has(2, 3)).toBe(true) // markets pair
    expect(has(0, 2)).toBe(false) // across topics
    // no duplicate undirected edges
    const keys = edges.map((e) => `${e.s}|${e.t}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('drops everything below minScore', () => {
    const texts = ['alpha bravo charlie', 'delta echo foxtrot']
    const nodes: GraphNodeInput[] = [
      { index: 0, text: texts[0], embedding: null },
      { index: 1, text: texts[1], embedding: null },
    ]
    expect(buildEdges(nodes, texts, { minScore: 0.1 })).toEqual([])
  })
})

describe('parseEmbedding', () => {
  it('parses the pgvector string format', () => {
    const parsed = parseEmbedding('[0.5,0.25,-1]')
    expect(parsed).toBeInstanceOf(Float32Array)
    expect(Array.from(parsed!)).toEqual([0.5, 0.25, -1])
  })

  it('accepts real arrays and rejects junk', () => {
    expect(Array.from(parseEmbedding([1, 2])!)).toEqual([1, 2])
    expect(parseEmbedding(null)).toBeNull()
    expect(parseEmbedding('')).toBeNull()
    expect(parseEmbedding('not json')).toBeNull()
    expect(parseEmbedding(42)).toBeNull()
  })
})
