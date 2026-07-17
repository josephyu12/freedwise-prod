-- Migration: Semantic search + highlight web on pgvector
-- Run this in your Supabase SQL editor.
-- Idempotent: safe to run multiple times.
--
-- Adds a 384-dim embedding column (gte-small, computed client-side in the
-- browser and backfilled once via script) plus the RPCs that power:
--   * /api/search semantic mode        -> match_highlights
--   * /api/search/similar              -> similar_highlights
--   * embedding sync (find stale rows) -> embedding_pending
--
-- embedding_hash = md5(text) at the moment the row was embedded. When a
-- highlight's text is edited the hash no longer matches md5(text), so the
-- row shows up in embedding_pending() and gets re-embedded lazily.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE highlights ADD COLUMN IF NOT EXISTS embedding vector(384);
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS embedding_hash TEXT;

-- HNSW index for fast approximate nearest-neighbor search by cosine distance.
-- Scales to the full library (no row cap), unlike the old TF-IDF scan.
CREATE INDEX IF NOT EXISTS idx_highlights_embedding_hnsw
  ON highlights USING hnsw (embedding vector_cosine_ops);

-- Semantic search: nearest highlights to an arbitrary query embedding.
-- SECURITY INVOKER + explicit auth.uid() filter: only the caller's rows,
-- matching the defense-in-depth pattern used in the API routes.
CREATE OR REPLACE FUNCTION match_highlights(
  query_embedding vector(384),
  match_count INT DEFAULT 30,
  min_similarity FLOAT DEFAULT 0.0
)
RETURNS TABLE (id UUID, similarity FLOAT)
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT h.id,
         1 - (h.embedding <=> query_embedding) AS similarity
  FROM highlights h
  WHERE h.user_id = auth.uid()
    AND h.archived = FALSE
    AND h.embedding IS NOT NULL
    AND 1 - (h.embedding <=> query_embedding) >= min_similarity
  ORDER BY h.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Similar highlights: nearest neighbors of an existing highlight,
-- using its stored embedding (no client-side embedding needed).
CREATE OR REPLACE FUNCTION similar_highlights(
  p_highlight_id UUID,
  match_count INT DEFAULT 10,
  min_similarity FLOAT DEFAULT 0.0
)
RETURNS TABLE (id UUID, similarity FLOAT)
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT h.id,
         1 - (h.embedding <=> src.embedding) AS similarity
  FROM highlights h,
       (SELECT embedding
        FROM highlights
        WHERE id = p_highlight_id
          AND user_id = auth.uid()
          AND embedding IS NOT NULL) src
  WHERE h.user_id = auth.uid()
    AND h.archived = FALSE
    AND h.id <> p_highlight_id
    AND h.embedding IS NOT NULL
    AND 1 - (h.embedding <=> src.embedding) >= min_similarity
  ORDER BY h.embedding <=> src.embedding
  LIMIT match_count;
$$;

-- Rows that still need (re-)embedding: never embedded, or text edited since.
-- Batched: the client embeds up to batch_count rows per sync pass.
CREATE OR REPLACE FUNCTION embedding_pending(
  batch_count INT DEFAULT 200
)
RETURNS TABLE (id UUID, text TEXT)
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT h.id, h.text
  FROM highlights h
  WHERE h.user_id = auth.uid()
    AND h.archived = FALSE
    AND (h.embedding IS NULL OR h.embedding_hash IS DISTINCT FROM md5(h.text))
  ORDER BY h.created_at DESC
  LIMIT batch_count;
$$;

-- Batched embedding write-back from the client sync loop.
-- Each item: { "id": uuid, "text": the exact text that was embedded,
-- "embedding": [384 floats] }. The hash is md5 of the text that was
-- actually embedded, so an edit racing the sync pass leaves the row
-- stale (hash mismatch) and it simply gets re-embedded next pass.
CREATE OR REPLACE FUNCTION set_highlight_embeddings(p_items JSONB)
RETURNS INT
LANGUAGE sql
SECURITY INVOKER
VOLATILE
AS $$
  WITH items AS (
    SELECT (item->>'id')::uuid          AS id,
           (item->>'embedding')::vector(384) AS emb,
           md5(item->>'text')           AS hash
    FROM jsonb_array_elements(p_items) item
  ),
  updated AS (
    UPDATE highlights h
    SET embedding = i.emb,
        embedding_hash = i.hash
    FROM items i
    WHERE h.id = i.id
      AND h.user_id = auth.uid()
    RETURNING h.id
  )
  SELECT COUNT(*)::int FROM updated;
$$;

-- Count of rows still pending, for sync progress UI.
CREATE OR REPLACE FUNCTION embedding_pending_count()
RETURNS BIGINT
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT COUNT(*)
  FROM highlights h
  WHERE h.user_id = auth.uid()
    AND h.archived = FALSE
    AND (h.embedding IS NULL OR h.embedding_hash IS DISTINCT FROM md5(h.text));
$$;
