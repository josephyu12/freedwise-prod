'use client'

import { useEffect, useRef, useState } from 'react'
import { embedTexts } from '@/lib/clientEmbeddings'

// Small batches keep WASM memory bounded while embedding in the browser.
const EMBED_CHUNK = 8
// Safety valve: 100 rows per pending fetch × 60 passes covers 6,000 rows.
const MAX_PASSES = 60

// Keeps the highlight embeddings up to date, entirely client-side:
// fetch rows whose text was never embedded (or edited since), embed them
// with gte-small in the browser, post the vectors back. Runs once per page
// mount; no-ops immediately when nothing is pending, which is the steady
// state — the backfill script handles the initial 1,582.
export function useEmbeddingSync() {
  const [remaining, setRemaining] = useState<number | null>(null)
  const [total, setTotal] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false

    const run = async () => {
      try {
        let res = await fetch('/api/embeddings/pending')
        if (!res.ok) return
        let data = await res.json()
        if (cancelled) return
        setRemaining(data.remaining)
        if (data.remaining > 0) {
          setTotal(data.remaining)
          setSyncing(true)
        }

        let passes = 0
        while (!cancelled && (data.pending?.length ?? 0) > 0 && passes < MAX_PASSES) {
          passes++
          const batch: { id: string; text: string }[] = data.pending

          const items: { id: string; text: string; embedding: number[] }[] = []
          for (let i = 0; i < batch.length && !cancelled; i += EMBED_CHUNK) {
            const chunk = batch.slice(i, i + EMBED_CHUNK)
            const vectors = await embedTexts(chunk.map((b) => b.text))
            chunk.forEach((b, j) => items.push({ id: b.id, text: b.text, embedding: vectors[j] }))
          }
          if (cancelled) return

          const up = await fetch('/api/embeddings/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items }),
          })
          if (!up.ok) {
            const body = await up.json().catch(() => ({}))
            throw new Error(body.error || 'Failed to save embeddings')
          }

          res = await fetch('/api/embeddings/pending')
          if (!res.ok) break
          data = await res.json()
          if (!cancelled) setRemaining(data.remaining)
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Embedding sync failed')
      } finally {
        if (!cancelled) setSyncing(false)
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [])

  return { syncing, remaining, total, error }
}
