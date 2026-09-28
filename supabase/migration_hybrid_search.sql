-- Migration: Hybrid (semantic + lexical) highlight search
-- Run this in your Supabase SQL editor.
-- Idempotent: safe to run multiple times.
-- Requires: migration_add_embeddings.sql (vector column + pgvector).
--
-- Why: "Semantic" search was vector-only with a hard 0.81 cosine floor. On
-- the real library gte-small clusters tightly (median query->highlight
-- similarity ~0.75, best matches ~0.85-0.95), so a paraphrase that landed at
-- 0.79 was silently dropped and nothing lexical could rescue it. Meanwhile
-- "Full Text" was a raw ILIKE substring match, so remembering the *gist* of
-- the wording ("best looking time of your life") found nothing either.
--
-- search_highlights_hybrid() runs both arms in one query and fuses them with
-- reciprocal rank fusion (RRF, k=60):
--   * semantic arm: top candidate_count highlights by cosine similarity,
--     above a LOW floor (default 0.75 — a noise guard, not a relevance cut).
--   * lexical arm:  Postgres full-text with English stemming (looking -> look,
--     lives -> life). A highlight qualifies when it contains the exact phrase,
--     or ALL of the query's stems (queries of up to 3 stems) / at least 75% of
--     them (longer queries) — strict on purpose: a weak one-word overlap must
--     not outrank the semantic arm's best match. Ordered by: exact phrase
--     match (shorter highlight first), then stems matched, then ts_rank_cd.
--   * The lexical RRF term is scaled by the fraction of stems matched, so a
--     3-of-4 match earns 75% of the credit of a full match.
--   * A highlight found by both arms outranks one found by only one.
--
-- query_embedding may be NULL (browser couldn't load the model): the function
-- then returns the lexical arm alone, which is still stemmed + ranked and so
-- strictly better than the old ILIKE fallback.

CREATE OR REPLACE FUNCTION search_highlights_hybrid(
  query_text TEXT,
  query_embedding vector(384) DEFAULT NULL,
  match_count INT DEFAULT 30,
  candidate_count INT DEFAULT 60,
  min_similarity FLOAT DEFAULT 0.75
)
RETURNS TABLE (
  id UUID,
  score FLOAT,
  similarity FLOAT,
  semantic_rank INT,
  lexical_rank INT
)
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  WITH params0 AS (
    -- Drop contraction suffixes ("you'll", "you’re", "don't") before stemming:
    -- the English parser would otherwise emit "ll" / "re" / "t" as lexemes and
    -- inflate the stem count.
    SELECT regexp_replace(query_text, '[''’](ll|re|ve|d|m|s|t)\M', ' ', 'gi') AS stem_src
  ),
  params AS (
    SELECT
      NULLIF(btrim(query_text), '') AS q,
      -- Escape LIKE metacharacters so a literal % or _ in the query is matched
      -- as text rather than as a wildcard.
      replace(replace(replace(btrim(query_text), '\', '\\'), '%', '\%'), '_', '\_') AS like_q,
      -- Distinct stemmed, stopword-free lexemes of the query.
      tsvector_to_array(to_tsvector('english', p0.stem_src)) AS stems,
      p0.stem_src
    FROM params0 p0
  ),
  params2 AS (
    SELECT
      p.*,
      cardinality(p.stems) AS n_stems,
      -- All stems for short queries; at least 75% (rounded up) for longer ones.
      CASE WHEN cardinality(p.stems) <= 3 THEN cardinality(p.stems)
           ELSE CEIL(cardinality(p.stems) * 0.75)::int END AS need_stems,
      -- OR-query over the stems for ts_rank_cd tie-breaking. plainto_tsquery
      -- emits "'best' & 'look' & 'time'"; lexemes can never contain '&', so
      -- rewriting the operator yields a well-quoted OR query.
      CASE WHEN cardinality(p.stems) > 0
           THEN to_tsquery('english', replace(plainto_tsquery('english', p.stem_src)::text, '&', '|'))
           ELSE NULL END AS tsq_any
    FROM params p
  ),
  scope AS (
    SELECT h.id, h.text, h.embedding
    FROM highlights h
    WHERE h.user_id = auth.uid()
      AND h.archived = FALSE
  ),
  semantic AS (
    SELECT s.id,
           1 - (s.embedding <=> query_embedding) AS similarity,
           row_number() OVER (ORDER BY s.embedding <=> query_embedding) AS rnk
    FROM scope s
    WHERE query_embedding IS NOT NULL
      AND s.embedding IS NOT NULL
      AND 1 - (s.embedding <=> query_embedding) >= min_similarity
    ORDER BY s.embedding <=> query_embedding
    LIMIT candidate_count
  ),
  lexical_candidates AS (
    -- Pre-filter: exact phrase, or any query stem present (@@ can use the
    -- GIN index from migration_add_fulltext_search.sql). The strict
    -- stem-count requirement is applied below on this reduced set.
    SELECT s.id,
           s.text,
           (s.text ILIKE '%' || p.like_q || '%') AS phrase_hit,
           to_tsvector('english', s.text) AS tsv
    FROM scope s, params2 p
    WHERE p.q IS NOT NULL
      AND (s.text ILIKE '%' || p.like_q || '%'
           OR (p.tsq_any IS NOT NULL AND to_tsvector('english', s.text) @@ p.tsq_any))
  ),
  lexical_scored AS (
    SELECT c.id,
           c.phrase_hit,
           length(c.text) AS text_len,
           (SELECT count(*)
              FROM unnest(p.stems) qs
             WHERE qs = ANY (tsvector_to_array(c.tsv))) AS matched,
           CASE WHEN p.tsq_any IS NOT NULL THEN ts_rank_cd(c.tsv, p.tsq_any) ELSE 0 END AS rank_cd
    FROM lexical_candidates c, params2 p
  ),
  lexical AS (
    SELECT l.id,
           CASE WHEN l.phrase_hit OR p.n_stems = 0 THEN 1.0
                ELSE l.matched::float / p.n_stems END AS weight,
           row_number() OVER (
             ORDER BY l.phrase_hit DESC,
                      CASE WHEN l.phrase_hit THEN l.text_len END ASC,
                      l.matched DESC, l.rank_cd DESC, l.id
           ) AS rnk
    FROM lexical_scored l, params2 p
    WHERE l.phrase_hit OR (p.n_stems > 0 AND l.matched >= p.need_stems)
    ORDER BY rnk
    LIMIT candidate_count
  ),
  fused AS (
    SELECT COALESCE(sem.id, lex.id) AS id,
           COALESCE(1.0 / (60 + sem.rnk), 0) + COALESCE(lex.weight / (60 + lex.rnk), 0) AS score,
           sem.similarity,
           sem.rnk AS semantic_rank,
           lex.rnk AS lexical_rank
    FROM semantic sem
    FULL OUTER JOIN lexical lex ON lex.id = sem.id
  )
  SELECT f.id,
         f.score::float,
         f.similarity::float,
         f.semantic_rank::int,
         f.lexical_rank::int
  FROM fused f
  ORDER BY f.score DESC, f.similarity DESC NULLS LAST, f.lexical_rank ASC NULLS LAST
  LIMIT match_count;
$$;
