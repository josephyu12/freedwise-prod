-- ============================================================================
-- ⚠️  DO NOT RUN THIS FILE.  SUPERSEDED — KEPT ONLY AS A POINTER.
-- ============================================================================
--
-- The original schema.sql created the tables with NO `user_id` column and
-- permissive `USING (true)` RLS policies — i.e. every user could read every
-- other user's highlights. That is exactly the failure mode we never want.
--
-- The canonical, user-isolated schema now lives in:
--
--     supabase/migration_complete.sql   (idempotent, safe to re-run)
--
-- It creates every table with a `user_id` column, enables RLS on all tables,
-- and installs per-user `auth.uid() = user_id` policies. See supabase/MIGRATIONS.md
-- for the full ordering of incremental migrations.
--
-- This guard makes accidentally executing this file a hard error instead of a
-- silent security regression.
-- ============================================================================

DO $$
BEGIN
  RAISE EXCEPTION
    'supabase/schema.sql is obsolete and unsafe to run. Use supabase/migration_complete.sql instead (see supabase/MIGRATIONS.md).';
END $$;
