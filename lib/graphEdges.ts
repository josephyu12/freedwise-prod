// Edge scoring for the /web highlight graph.
//
// Each pair of highlights gets a blended score:
//   0.7 * meaning   (cosine similarity of gte-small embeddings, rescaled)
//   0.3 * words     (idf-weighted overlap of distinctive words)
// exactly the "meaning + the words they contain" combination the graph
// visualizes. Nodes missing an embedding (not yet synced) fall back to
// word overlap alone, so they still join the web instead of floating.
//
// Pure functions, no I/O — unit-tested in __tests__/graphEdges.test.ts.

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every',
  'other', 'another', 'some', 'any', 'no', 'not', 'only', 'just', 'more', 'most',
  'very', 'too', 'so', 'than', 'then', 'there', 'their', 'them',
  'about', 'into', 'through', 'during', 'including', 'against', 'among', 'throughout',
  'despite', 'towards', 'upon', 'concerning', 'up', 'out', 'if', 'because', 'your',
  'my', 'our', 'his', 'her', 'its', 'me', 'him', 'us', 'don', 'own', 'also', 'one',
  'even', 'like', 'get', 'got', 'let', 'said', 'say', 'says',
])

// Meaning rescale: gte-small cosine between unrelated passages still sits
// around ~0.72-0.82 (median 0.78 in the real library), so raw cosine is a
// poor edge weight. Map [floor, 1.0] onto [0, 1] and clamp; below the floor
// counts as zero meaning-similarity.
const MEANING_FLOOR = 0.78

const MEANING_WEIGHT = 0.7
const WORD_WEIGHT = 0.3

export interface GraphNodeInput {
  index: number
  text: string
  embedding: Float32Array | null
}

export interface GraphEdge {
  s: number
  t: number
  w: number
}

// Lowercase words, stopword-filtered, light plural trim only. The old
// suffix-stripping stemmer mapped inflections of one word to DIFFERENT
// stems (create/creat/crea) and is deliberately not reproduced here.
export function tokenize(text: string): string[] {
  const plain = text.replace(/<[^>]*>/g, ' ').toLowerCase()
  const words = plain.match(/[a-z]+(?:[-'][a-z]+)*/g) || []
  const out: string[] = []
  for (let word of words) {
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
      word = word.slice(0, -1)
    }
    if (word.length > 2 && !STOP_WORDS.has(word)) out.push(word)
  }
  return out
}

interface WordDoc {
  words: string[]
  weights: Float32Array
  norm: number
  // word -> position in weights; built once so pair scoring never allocates
  index: Map<string, number>
}

// idf-weighted binary word vectors: shared rare words count for a lot,
// shared common words for almost nothing.
export function buildWordDocs(texts: string[]): WordDoc[] {
  const tokenSets = texts.map((t) => new Set(tokenize(t)))
  const df = new Map<string, number>()
  for (const set of tokenSets) {
    for (const w of set) df.set(w, (df.get(w) || 0) + 1)
  }
  const n = texts.length
  const idf = new Map<string, number>()
  for (const [w, count] of df) idf.set(w, Math.log(1 + n / count))

  return tokenSets.map((set) => {
    const words = [...set]
    const weights = new Float32Array(words.length)
    const index = new Map<string, number>()
    let sq = 0
    words.forEach((w, i) => {
      const v = idf.get(w) || 0
      weights[i] = v
      sq += v * v
      index.set(w, i)
    })
    return { words, weights, norm: Math.sqrt(sq), index }
  })
}

export function wordSimilarity(a: WordDoc, b: WordDoc): number {
  if (a.norm === 0 || b.norm === 0) return 0
  // Iterate the smaller doc, look up in the larger one's prebuilt index.
  const [small, large] = a.words.length <= b.words.length ? [a, b] : [b, a]
  let dot = 0
  small.words.forEach((w, i) => {
    const j = large.index.get(w)
    if (j !== undefined) dot += small.weights[i] * large.weights[j]
  })
  return dot / (a.norm * b.norm)
}

export function meaningSimilarity(a: Float32Array, b: Float32Array): number {
  // Embeddings are L2-normalized, so dot product == cosine.
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return Math.min(Math.max((dot - MEANING_FLOOR) / (1 - MEANING_FLOOR), 0), 1)
}

export function pairScore(
  aEmb: Float32Array | null,
  bEmb: Float32Array | null,
  aWords: WordDoc,
  bWords: WordDoc
): number {
  const word = wordSimilarity(aWords, bWords)
  if (!aEmb || !bEmb) return word // no embedding yet: words carry the edge
  return MEANING_WEIGHT * meaningSimilarity(aEmb, bEmb) + WORD_WEIGHT * word
}

// Build the edge list: each node contributes its top-k strongest partners,
// edges below minScore are dropped, duplicates merged. Keeps the graph
// readable at ~1,500 nodes instead of a hairball.
export function buildEdges(
  nodes: GraphNodeInput[],
  texts: string[],
  { topK = 4, minScore = 0.22 }: { topK?: number; minScore?: number } = {}
): GraphEdge[] {
  const n = nodes.length
  const wordDocs = buildWordDocs(texts)
  // Per-node top-k candidate lists, filled from a single pass over pairs.
  const best: { j: number; w: number }[][] = Array.from({ length: n }, () => [])

  const insert = (list: { j: number; w: number }[], j: number, w: number) => {
    if (list.length < topK) {
      list.push({ j, w })
      list.sort((a, b) => b.w - a.w)
    } else if (w > list[list.length - 1].w) {
      list[list.length - 1] = { j, w }
      list.sort((a, b) => b.w - a.w)
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const w = pairScore(nodes[i].embedding, nodes[j].embedding, wordDocs[i], wordDocs[j])
      if (w < minScore) continue
      insert(best[i], j, w)
      insert(best[j], i, w)
    }
  }

  const seen = new Set<string>()
  const edges: GraphEdge[] = []
  for (let i = 0; i < n; i++) {
    for (const { j, w } of best[i]) {
      const key = i < j ? `${i}|${j}` : `${j}|${i}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ s: Math.min(i, j), t: Math.max(i, j), w: Number(w.toFixed(4)) })
    }
  }
  return edges
}

// PostgREST returns vector columns as a "[0.1,0.2,...]" string.
export function parseEmbedding(raw: unknown): Float32Array | null {
  if (typeof raw !== 'string' || raw.length < 2) {
    return Array.isArray(raw) ? Float32Array.from(raw as number[]) : null
  }
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? Float32Array.from(arr) : null
  } catch {
    return null
  }
}
