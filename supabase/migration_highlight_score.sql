-- ============================================================================
-- MIGRATION: Stored per-highlight score (plain-text character count)
-- ============================================================================
-- The bin-packing routes (assign / redistribute / apply-frequency /
-- prepare-next-cycle) balance days by each highlight's plain-text length. They
-- used to download EVERY highlight's full text + html_content on every call
-- just to compute that number — adding one highlight shipped the whole library
-- over the wire. The score is now a STORED generated column and those routes
-- select (id, score) only.
--
-- Parity with the TypeScript scoring it replaces:
--   (h.html_content || h.text || '').replace(/<[^>]*>/g, '').length
-- nullif() mirrors JS ||-falsiness for the empty string, not just NULL.
--
-- MUST be run before deploying the code that selects `score`.
-- Idempotent. Date: 2026-07-09
-- ============================================================================

ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS score INTEGER GENERATED ALWAYS AS (
    char_length(regexp_replace(coalesce(nullif(html_content, ''), text, ''), '<[^>]*>', '', 'g'))
  ) STORED;
