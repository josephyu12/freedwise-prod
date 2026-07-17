// One-time (re-runnable) embedding backfill.
//
// Embeds every highlight whose embedding is missing or stale (embedding_hash
// != md5(text)) with gte-small — the same model the browser uses — and writes
// vectors straight to Supabase with the service role key. Safe to re-run:
// up-to-date rows are skipped.
//
// Usage: node scripts/backfill-embeddings.mjs
// Requires: .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY,
// and the migration supabase/migration_add_embeddings.sql already applied.

import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { pipeline } from '@xenova/transformers'

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
)
const BASE = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!BASE || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
// Must match lib/clientEmbeddings.ts embeddingInput().
const embeddingInput = (text) => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

async function fetchAllHighlights() {
  const rows = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const res = await fetch(
      `${BASE}/rest/v1/highlights?select=id,text,embedding_hash&order=created_at.asc`,
      { headers: { ...HEADERS, Range: `${from}-${from + page - 1}` } }
    )
    if (!res.ok && res.status !== 206) {
      throw new Error(`fetch highlights failed: ${res.status} ${await res.text()}`)
    }
    const batch = await res.json()
    rows.push(...batch)
    if (batch.length < page) return rows
  }
}

const all = await fetchAllHighlights()
const stale = all.filter((h) => h.embedding_hash !== md5(h.text))
console.log(`highlights: ${all.length} total, ${stale.length} need embedding`)
if (stale.length === 0) process.exit(0)

console.log('loading gte-small (first run downloads ~30MB)...')
const extractor = await pipeline('feature-extraction', 'Xenova/gte-small', { quantized: true })

const CHUNK = 16
let done = 0
let failed = 0
for (let i = 0; i < stale.length; i += CHUNK) {
  const chunk = stale.slice(i, i + CHUNK)
  const output = await extractor(chunk.map((h) => embeddingInput(h.text)), {
    pooling: 'mean',
    normalize: true,
  })
  const vectors = output.tolist()

  await Promise.all(
    chunk.map(async (h, j) => {
      const res = await fetch(`${BASE}/rest/v1/highlights?id=eq.${h.id}`, {
        method: 'PATCH',
        headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          embedding: `[${vectors[j].join(',')}]`,
          embedding_hash: md5(h.text),
        }),
      })
      if (!res.ok) {
        failed++
        console.error(`  PATCH failed for ${h.id}: ${res.status} ${await res.text()}`)
      }
    })
  )
  done += chunk.length
  process.stdout.write(`\rembedded ${done}/${stale.length}`)
}
console.log(`\ndone. failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
