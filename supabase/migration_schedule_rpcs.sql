-- ============================================================================
-- MIGRATION: Transactional write-phase RPCs for the scheduling engine
-- ============================================================================
-- apply-frequency / assign / redistribute / reset-cycle previously performed
-- their write phases as long sequences of independent PostgREST calls — a
-- timeout or dropped connection mid-sequence left the schedule half-cleared or
-- half-written (empty days until a manual re-run). Each write phase is now ONE
-- function: a single transaction that fully applies or fully rolls back, in
-- one round trip instead of dozens.
--
-- Layout COMPUTATION (deterministic bin-packing, cycle math) deliberately
-- stays in TypeScript: it is pure, unit-tested, and its determinism /
-- reversibility invariants (REVIEW_FREQUENCY_PLAN.md §8) must not risk
-- divergence against a second implementation in SQL. These functions only
-- APPLY a computed layout.
--
-- All functions are SECURITY INVOKER — RLS stays in force for every statement
-- — and additionally scope every write to auth.uid() explicitly.
--
-- MUST be run before deploying the code that calls these functions.
-- Idempotent. Date: 2026-07-09
-- ============================================================================

-- ----------------------------------------------------------------------------
-- place_assignments(p_buckets)
--   Apply a computed layout: create any missing daily_summaries and insert the
--   assignment rows, ignoring duplicates. Insert-only — never deletes.
--   p_buckets: [{ "date": "YYYY-MM-DD", "highlight_ids": ["uuid", ...] }, ...]
--   Used directly by /api/daily/redistribute and as the final step of the
--   clearing functions below.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION place_assignments(p_buckets jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_buckets IS NULL OR jsonb_array_length(p_buckets) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO daily_summaries (date, user_id)
  SELECT DISTINCT (b->>'date')::date, v_user
  FROM jsonb_array_elements(p_buckets) b
  WHERE jsonb_array_length(coalesce(b->'highlight_ids', '[]'::jsonb)) > 0
  ON CONFLICT (date, user_id) DO NOTHING;

  INSERT INTO daily_summary_highlights (daily_summary_id, highlight_id)
  SELECT ds.id, hid::uuid
  FROM jsonb_array_elements(p_buckets) b
  JOIN daily_summaries ds
    ON ds.user_id = v_user AND ds.date = (b->>'date')::date
  CROSS JOIN LATERAL jsonb_array_elements_text(b->'highlight_ids') hid
  ON CONFLICT (daily_summary_id, highlight_id) DO NOTHING;
END $$;

-- ----------------------------------------------------------------------------
-- retile_schedule(p_frequency, p_ledgers, p_buckets)
--   The whole apply-frequency write phase, atomically:
--     1. persist the new frequency (daily_review_enabled untouched),
--     2. rebuild the reviewed ledger for each provided cycle key to exactly
--        the given ids (minimal diff — surviving rows keep created_at),
--     3. delete EVERY unrated (to-do) assignment row library-wide
--        (rated rows are immutable anchors and are never touched),
--     4. drop summaries left with no rows at all,
--     5. apply the freshly computed layout.
--   p_ledgers: [{ "month_year": "YYYY-MM", "highlight_ids": ["uuid", ...] }, ...]
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION retile_schedule(
  p_frequency integer,
  p_ledgers   jsonb,
  p_buckets   jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_ledger jsonb;
  v_key    text;
  v_ids    uuid[];
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_frequency IS NULL OR p_frequency < 1 OR p_frequency > 12 THEN
    RAISE EXCEPTION 'invalid frequency %', p_frequency;
  END IF;

  INSERT INTO user_review_settings (user_id, frequency_months)
  VALUES (v_user, p_frequency)
  ON CONFLICT (user_id) DO UPDATE SET frequency_months = EXCLUDED.frequency_months;

  FOR v_ledger IN SELECT * FROM jsonb_array_elements(coalesce(p_ledgers, '[]'::jsonb)) LOOP
    v_key := v_ledger->>'month_year';
    v_ids := coalesce(
      (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(v_ledger->'highlight_ids') x),
      '{}'::uuid[]
    );
    DELETE FROM highlight_months_reviewed hmr
    USING highlights h
    WHERE hmr.highlight_id = h.id
      AND h.user_id = v_user
      AND hmr.month_year = v_key
      AND NOT (hmr.highlight_id = ANY (v_ids));
    INSERT INTO highlight_months_reviewed (highlight_id, month_year)
    SELECT unnest(v_ids), v_key
    ON CONFLICT (highlight_id, month_year) DO NOTHING;
  END LOOP;

  DELETE FROM daily_summary_highlights dsh
  USING daily_summaries ds
  WHERE dsh.daily_summary_id = ds.id
    AND ds.user_id = v_user
    AND dsh.rating IS NULL;

  DELETE FROM daily_summaries ds
  WHERE ds.user_id = v_user
    AND NOT EXISTS (
      SELECT 1 FROM daily_summary_highlights dsh WHERE dsh.daily_summary_id = ds.id
    );

  PERFORM place_assignments(p_buckets);
END $$;

-- ----------------------------------------------------------------------------
-- assign_cycle_layout(p_cycle_start, p_cycle_end, p_buckets)
--   The /api/daily/assign write phase, atomically: delete the cycle's unrated
--   rows (rated rows stay put; summaries are KEPT so days holding rated rows
--   survive and empty ones get reused), then apply the layout.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_cycle_layout(
  p_cycle_start date,
  p_cycle_end   date,
  p_buckets     jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  DELETE FROM daily_summary_highlights dsh
  USING daily_summaries ds
  WHERE dsh.daily_summary_id = ds.id
    AND ds.user_id = v_user
    AND ds.date BETWEEN p_cycle_start AND p_cycle_end
    AND dsh.rating IS NULL;

  PERFORM place_assignments(p_buckets);
END $$;

-- ----------------------------------------------------------------------------
-- reset_cycle(p_cycle_start, p_cycle_end, p_cycle_key)
--   The /api/daily/reset-cycle write phase, atomically: remove every
--   assignment row and summary in the cycle window (an explicit user reset is
--   the ONE path allowed to delete rated rows) plus the cycle's reviewed
--   ledger entries.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reset_cycle(
  p_cycle_start date,
  p_cycle_end   date,
  p_cycle_key   text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  DELETE FROM daily_summary_highlights dsh
  USING daily_summaries ds
  WHERE dsh.daily_summary_id = ds.id
    AND ds.user_id = v_user
    AND ds.date BETWEEN p_cycle_start AND p_cycle_end;

  DELETE FROM daily_summaries
  WHERE user_id = v_user
    AND date BETWEEN p_cycle_start AND p_cycle_end;

  DELETE FROM highlight_months_reviewed hmr
  USING highlights h
  WHERE hmr.highlight_id = h.id
    AND h.user_id = v_user
    AND hmr.month_year = p_cycle_key;
END $$;
