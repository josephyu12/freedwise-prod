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

5. **`migration_make_highlight_id_nullable_in_sync_queue.sql`** (Latest)
   - Makes `highlight_id` nullable in `notion_sync_queue` table
   - Required for delete operations: when a highlight is deleted, we still need to sync the deletion to Notion
   - Without this, the foreign key CASCADE would delete the queue item when the highlight is deleted
   - **Date:** 2026-01-XX

## Migration Order

If applying migrations incrementally, use this order:

1. Base schema (if starting from scratch, use `migration_complete.sql`)
2. `migration_add_months_reviewed.sql`
3. `migration_add_archived.sql`
4. `migration_add_fulltext_search.sql`
5. `migration_add_original_text_to_sync_queue.sql`
6. `migration_make_highlight_id_nullable_in_sync_queue.sql`

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
```

## Notes

- All migrations are idempotent (safe to run multiple times)
- The complete migration includes all incremental changes
- Always backup your database before running migrations in production

