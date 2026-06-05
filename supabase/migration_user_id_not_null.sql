-- Migration: enforce NOT NULL on every user-owning column.
--
-- Why: a row with user_id IS NULL is invisible under the `auth.uid() = user_id`
-- RLS policies (it can never match any caller), so it silently disappears from
-- the app — but its existence means some code path inserted a highlight/summary/
-- category without an owner. Making the column NOT NULL turns that latent bug
-- into a loud, immediate failure at write time instead of a ghost row.
--
-- Safety: there is no way to retroactively assign an owner to an orphan row, so
-- this migration does NOT delete or guess. If any orphan rows exist it leaves
-- the constraint untouched and prints exactly how many, so you can investigate
-- and clean up, then re-run. Idempotent.
-- **Date:** 2026-06-05

DO $$
DECLARE
  v_orphans bigint;
  v_tbl     text;
  v_blocked boolean := false;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['highlights', 'daily_summaries', 'categories']
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE user_id IS NULL', v_tbl)
      INTO v_orphans;

    IF v_orphans > 0 THEN
      RAISE WARNING
        '[user_id NOT NULL] % has % orphan row(s) with user_id IS NULL — NOT enforcing constraint on this table. Investigate/clean up, then re-run.',
        v_tbl, v_orphans;
      v_blocked := true;
    ELSE
      EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id SET NOT NULL', v_tbl);
      RAISE NOTICE '[user_id NOT NULL] % is clean — user_id is now NOT NULL.', v_tbl;
    END IF;
  END LOOP;

  IF v_blocked THEN
    RAISE WARNING
      '[user_id NOT NULL] One or more tables were skipped due to orphan rows. Re-run after cleanup to complete the migration.';
  END IF;
END $$;
