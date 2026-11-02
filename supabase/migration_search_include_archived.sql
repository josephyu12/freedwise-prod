-- Archive-aware hybrid search. Requires migration_add_embeddings.sql.
-- New function name preserves existing clients and avoids ambiguous PostgREST
-- overload resolution. The route falls back to older functions for active-only
-- search, or keyword search for archived scope until this migration is applied.
-- Ranking is otherwise identical to migration_hybrid_search.sql.
-- SECURITY INVOKER + auth.uid() scope apply to both active and archived rows.

CREATE OR REPLACE FUNCTION search_highlights_hybrid_v2(
  query_text TEXT,
  query_embedding vector(384) DEFAULT NULL,
  match_count INT DEFAULT 30,
  candidate_count INT DEFAULT 60,
  min_similarity FLOAT DEFAULT 0.75,
  include_archived BOOLEAN DEFAULT FALSE
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
      AND (include_archived OR h.archived = FALSE)
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
