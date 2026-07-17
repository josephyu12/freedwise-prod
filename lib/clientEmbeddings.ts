// Client-side text embeddings via transformers.js (gte-small, 384-dim).
//
// The model (~20MB quantized) is downloaded once per browser and cached by
// the transformers.js browser cache, so the server never runs inference and
// the Vercel bundle is untouched — @xenova/transformers is only pulled
// in through the dynamic import below, on the pages that call this.
//
// Embeddings are L2-normalized, so cosine similarity == dot product and
// pgvector's <=> cosine distance behaves as expected.

export const EMBEDDING_DIM = 384
const MODEL_ID = 'Xenova/gte-small'

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist(): number[][] }>

let extractorPromise: Promise<FeatureExtractor> | null = null

export function isEmbedderLoading(): boolean {
  return extractorPromise !== null
}

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers')
      const extractor = await pipeline('feature-extraction', MODEL_ID, {
        quantized: true,
      })
      return extractor as unknown as FeatureExtractor
    })()
    // A failed load (offline, HF unreachable) must not poison future calls.
    extractorPromise.catch(() => {
      extractorPromise = null
    })
  }
  return extractorPromise
}

// Strip HTML and collapse whitespace so markup never influences the vector.
export function embeddingInput(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const extractor = await getExtractor()
  const output = await extractor(texts.map(embeddingInput), {
    pooling: 'mean',
    normalize: true,
  })
  return output.tolist()
}

export async function embedText(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text])
  return vector
}

// Warm the model in the background; resolves true when ready, false on failure
// (callers fall back to keyword search rather than surfacing an error).
export async function preloadEmbedder(): Promise<boolean> {
  try {
    await getExtractor()
    return true
  } catch {
    return false
  }
}
