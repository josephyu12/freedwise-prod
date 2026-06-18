# Database Migrations

This directory contains SQL migration files for the Freedwise database.

## Migration Files

### Complete Migration (Recommended for New Databases)
- **`migration_complete.sql`** - Complete database schema from scratch
  - Creates all tables, indexes, constraints, RLS policies, and triggers
  - Includes all features: user isolation, archived highlights, full-text search, Notion sync queue
  - **Use this for:** Setting up a new database or completely resetting an existing one
  - **Idempotent:** Safe to run multiple times

### Incremental Migrations (For Existing Databases)

These migrations can be applied individually to update existing databases:

1. **`migration_add_months_reviewed.sql`**
   - Adds `highlight_months_reviewed` table
   - Tracks which months each highlight has been reviewed

2. **`migration_add_archived.sql`**
   - Adds `archived` column to `highlights` table
   - Allows archiving highlights without deleting them

3. **`migration_add_fulltext_search.sql`**
   - Adds GIN indexes for full-text search on `highlights.text` and `highlights.html_content`
   - Enables PostgreSQL full-text search capabilities

4. **`migration_add_original_text_to_sync_queue.sql`**
   - Adds `original_text` and `original_html_content` columns to `notion_sync_queue` table
   - Required for update operations to find and update the correct blocks in Notion
   - **Date:** 2026-01-XX

5. **`migration_make_highlight_id_nullable_in_sync_queue.sql`**
   - Makes `highlight_id` nullable in `notion_sync_queue` table
   - Required for delete operations: when a highlight is deleted, we still need to sync the deletion to Notion
   - Without this, the foreign key CASCADE would delete the queue item when the highlight is deleted
   - **Date:** 2026-01-XX

6. **`migration_resurface_stats.sql`**
   - Adds triggers to keep `highlights.resurface_count` and `highlights.last_resurfaced` in sync
   - `resurface_count` = number of distinct months reviewed; `last_resurfaced` = most recent rating timestamp
   - Includes a one-time backfill (these fields were never written by app code prior to this migration)
   - **Date:** 2026-05-10

7. **`migration_fix_last_resurfaced_tz.sql`**
   - Corrects `last_resurfaced` values that the prior backfill anchored at midnight UTC
   - Re-anchors at noon UTC so `toLocaleDateString()` renders the right calendar day in negative-offset timezones (ET, etc.)
   - Idempotent; only touches rows that look like the bad midnight-UTC cast
   - **Date:** 2026-05-10

8. **`migration_dedupe_text_unique.sql`**
   - Adds a generated `text_hash` column (md5 of normalized text) and a unique
     constraint on `(user_id, text_hash)` so the database enforces "no duplicate
     highlights per user."
   - Removes pre-existing duplicates first (keeping the oldest per user/text).
   - Lets the app `.upsert(..., { ignoreDuplicates: true })` without a pre-insert
     dedup fetch, which used to dominate save latency.
   - **Date:** 2026-05-11

9. **`migration_user_id_not_null.sql`**
   - Enforces `NOT NULL` on `user_id` for `highlights`, `daily_summaries`, and
     `categories`. A NULL `user_id` is invisible under RLS (matches no caller),
     so it's both silent data loss and a sign of an owner-less write path.
   - Safe on dirty data: skips any table that still has orphan rows and reports
     the count instead of failing. Idempotent — re-run after cleanup.
   - **Date:** 2026-06-05

10. **`migration_review_frequency.sql`** (Latest)
   - Adds `user_review_settings` (`frequency_months` 1–12, `daily_review_enabled`)
     for configurable per-user review cadence (monthly … yearly) and an on/off
     switch for daily review.
   - Reinterprets `highlight_months_reviewed.month_year` as a generic "cycle key"
     (the cycle's start month). For `frequency_months = 1` (the default) the cycle
     key IS the calendar month, so **all existing rows stay valid — no data
     migration**. Defaults (monthly + enabled) mean existing users are unaffected.
   - Idempotent; RLS-correct.
   - **Date:** 2026-06-18

## Migration Order

If applying migrations incrementally, use this order:

1. Base schema (if starting from scratch, use `migration_complete.sql`)
2. `migration_add_months_reviewed.sql`
3. `migration_add_archived.sql`
4. `migration_add_fulltext_search.sql`
5. `migration_add_original_text_to_sync_queue.sql`
6. `migration_make_highlight_id_nullable_in_sync_queue.sql`
7. `migration_resurface_stats.sql`
8. `migration_fix_last_resurfaced_tz.sql`
9. `migration_dedupe_text_unique.sql`
10. `migration_user_id_not_null.sql`
11. `migration_review_frequency.sql`

## Usage

### For New Databases
```sql
-- Run the complete migration
\i migration_complete.sql
```

### For Existing Databases
```sql
-- Apply incremental migrations in order
\i migration_add_months_reviewed.sql
\i migration_add_archived.sql
\i migration_add_fulltext_search.sql
\i migration_add_original_text_to_sync_queue.sql
\i migration_make_highlight_id_nullable_in_sync_queue.sql
\i migration_resurface_stats.sql
\i migration_fix_last_resurfaced_tz.sql
\i migration_dedupe_text_unique.sql
\i migration_user_id_not_null.sql
\i migration_review_frequency.sql
```

## Notes

- All migrations are idempotent (safe to run multiple times)
- The complete migration includes all incremental changes
- Always backup your database before running migrations in production

