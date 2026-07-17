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

10. **`migration_review_frequency.sql`**
   - Adds `user_review_settings` (`frequency_months` 1–12, `daily_review_enabled`)
     for configurable per-user review cadence (monthly … yearly) and an on/off
     switch for daily review.
   - Reinterprets `highlight_months_reviewed.month_year` as a generic "cycle key"
     (the cycle's start month). For `frequency_months = 1` (the default) the cycle
     key IS the calendar month, so **all existing rows stay valid — no data
     migration**. Defaults (monthly + enabled) mean existing users are unaffected.
   - Idempotent; RLS-correct.
   - **Date:** 2026-06-18

11. **`migration_rating_to_text.sql`**
   - Converts `daily_summary_highlights.rating` from the old INTEGER 1–5 scale to
     TEXT (`'low'/'med'/'high'`) — the values the app reads and writes everywhere.
   - Recalculates `average_rating`/`rating_count` on the new low=1/med=2/high=3
     scale and auto-archives highlights with 2+ lows.
   - **Not idempotent on its own** (kept for history); `migration_complete.sql`
     contains a guarded, run-once version.

12. **`migration_unarchived_at.sql`**
   - Adds `highlights.unarchived_at` so auto-archive only counts low ratings
     dated after a manual unarchive.

13. **`migration_add_pinned_highlights.sql`**
   - Adds `pinned_highlights` (max 10 per user, trigger-enforced) + RLS.

14. **`migration_drop_sync_queue_cascade.sql`**
   - Drops the FK cascade on `notion_sync_queue.highlight_id` so deleting a
     highlight can't race the cancel-pending-add logic and orphan a `delete` op.
   - **Date:** 2026-05-13

15. **`migration_notion_sync_trigger.sql`**
   - `enqueue_notion_sync` trigger: writes the `notion_sync_queue` row in the
     SAME transaction as the highlight insert/update/delete, so the queue and
     the highlights table can never disagree.

16. **`migration_review_ahead_order.sql`**
   - Adds `review_ahead_order` (one row per user+cycle) — the server-side home
     for the frozen review-ahead sequence so every device resumes the same order.

17. **`migration_widget_token_version.sql`**
   - Adds `user_widget_settings.token_version` so widget tokens can be revoked:
     tokens embed the version they were signed with, and DELETE /api/widget-token
     bumps it to invalidate every outstanding token at once.
   - **Date:** 2026-07-09

18. **`migration_highlight_score.sql`**
   - Adds a STORED generated `highlights.score` column (plain-text length) so
     the bin-packing routes select (id, score) instead of downloading the whole
     library's text on every add/split/delete.
   - **Required before deploying the code that selects `score`.**
   - **Date:** 2026-07-09

19. **`migration_schedule_rpcs.sql`**
   - Adds the transactional write-phase functions (`place_assignments`,
     `retile_schedule`, `assign_cycle_layout`, `reset_cycle`) so each scheduling
     operation fully applies or fully rolls back in one round trip. Layout
     computation stays in the unit-tested TypeScript packer.
   - **Required before deploying the code that calls these functions.**
   - **Date:** 2026-07-09

20. **`migration_notion_realtime.sql`**
   - Adds `notion_sync_queue` to the `supabase_realtime` publication so queue
     changes push to the client over the websocket instead of a 10s poll.
   - **Date:** 2026-07-09

21. **`migration_add_embeddings.sql`** (Latest)
   - Enables the `vector` extension (pgvector) and adds `embedding vector(384)`
     + `embedding_hash` columns to `highlights`, with an HNSW cosine index.
   - Adds RPCs: `match_highlights` (semantic search), `similar_highlights`
     (neighbors of an existing highlight), `embedding_pending` /
     `embedding_pending_count` (lazy re-embedding of new or edited highlights).
   - Embeddings are gte-small vectors computed client-side in the browser;
     backfill for existing highlights runs once via script.
   - **Required before deploying the pgvector semantic search + /web graph.**
   - **Date:** 2026-07-16

## Migration Order

If applying migrations incrementally, use this order:

1. Base schema (if starting from scratch, use `migration_complete.sql` and stop —
   it already contains everything below)
2. `migration_add_months_reviewed.sql`
3. `migration_add_archived.sql`
4. `migration_rating_to_text.sql`
5. `migration_unarchived_at.sql`
6. `migration_add_pinned_highlights.sql`
7. `migration_add_fulltext_search.sql`
8. `migration_add_original_text_to_sync_queue.sql`
9. `migration_make_highlight_id_nullable_in_sync_queue.sql`
10. `migration_drop_sync_queue_cascade.sql`
11. `migration_resurface_stats.sql`
12. `migration_fix_last_resurfaced_tz.sql`
13. `migration_dedupe_text_unique.sql`
14. `migration_notion_sync_trigger.sql`
15. `migration_user_id_not_null.sql`
16. `migration_review_frequency.sql`
17. `migration_review_ahead_order.sql`
18. `migration_widget_token_version.sql`
19. `migration_highlight_score.sql`
20. `migration_schedule_rpcs.sql`
21. `migration_notion_realtime.sql`
22. `migration_add_embeddings.sql`

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
\i migration_rating_to_text.sql
\i migration_unarchived_at.sql
\i migration_add_pinned_highlights.sql
\i migration_add_fulltext_search.sql
\i migration_add_original_text_to_sync_queue.sql
\i migration_make_highlight_id_nullable_in_sync_queue.sql
\i migration_drop_sync_queue_cascade.sql
\i migration_resurface_stats.sql
\i migration_fix_last_resurfaced_tz.sql
\i migration_dedupe_text_unique.sql
\i migration_notion_sync_trigger.sql
\i migration_user_id_not_null.sql
\i migration_review_frequency.sql
\i migration_review_ahead_order.sql
\i migration_widget_token_version.sql
\i migration_highlight_score.sql
\i migration_schedule_rpcs.sql
\i migration_notion_realtime.sql
```

## Notes

- All migrations are idempotent (safe to run multiple times)
- The complete migration includes all incremental changes
- Always backup your database before running migrations in production

