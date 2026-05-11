-- Migration: enforce per-user uniqueness on highlight text via a normalized hash.
--
-- Why a hash column instead of a unique index on `text` directly:
--   * Postgres btree pages have a ~2700-byte row limit. Highlights can exceed
--     that, so a unique index on the raw text would silently fail later.
--   * The hash column is a STORED generated column normalized for whitespace
--     and case, so "Hello" / "hello" / "Hello  " all collide as expected.
--
-- App side: insert with .upsert({ ignoreDuplicates: true, onConflict: 'user_id,text_hash' }).
-- Postgres will emit ON CONFLICT DO NOTHING, return only the actually-inserted
-- rows, and the app can surface a soft "N duplicate(s) skipped" notice.
--
-- Run this in your Supabase SQL editor. Safe to run more than once.

-- 1) Add the generated hash column. Normalizes:
--    - trims leading/trailing whitespace
--    - collapses runs of whitespace to a single space
--    - lowercases
--    - md5s the result so the column is bounded length.
ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS text_hash text GENERATED ALWAYS AS (
    md5(lower(regexp_replace(trim(coalesce(text, '')), '\s+', ' ', 'g')))
  ) STORED;

-- 2) Remove existing duplicates BEFORE the constraint is added, otherwise the
--    constraint creation fails. We keep the oldest row per (user_id, text_hash).
--    The CASCADE on highlight_categories / highlight_links / etc. is already
--    declared in the schema, so deleting losing duplicates cleans up related
--    rows automatically.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, text_hash
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM highlights
  WHERE text_hash IS NOT NULL
)
DELETE FROM highlights
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3) Enforce uniqueness.
ALTER TABLE highlights
  DROP CONSTRAINT IF EXISTS highlights_user_id_text_hash_key;
ALTER TABLE highlights
  ADD CONSTRAINT highlights_user_id_text_hash_key
  UNIQUE (user_id, text_hash);
