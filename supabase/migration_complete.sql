-- ============================================================================
-- COMPLETE DATABASE MIGRATION FOR FREEDWISE
-- ============================================================================
-- This file consolidates all database migrations into a single script.
-- Run this in your Supabase SQL editor to set up the complete database schema.
-- This migration is idempotent - it can be run multiple times safely.
-- ============================================================================

-- ============================================================================
-- 1. CREATE TABLES
-- ============================================================================

-- Create categories table
CREATE TABLE IF NOT EXISTS categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#3B82F6',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Create highlights table
CREATE TABLE IF NOT EXISTS highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  text TEXT NOT NULL,
  html_content TEXT, -- Rich text HTML content
  source TEXT,
  author TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_resurfaced TIMESTAMP WITH TIME ZONE,
  resurface_count INTEGER DEFAULT 0,
  average_rating DECIMAL(3,2) DEFAULT 0, -- Average of ratings (low=1, med=2, high=3)
  rating_count INTEGER DEFAULT 0,
  archived BOOLEAN DEFAULT FALSE,
  -- Set when the user manually unarchives; auto-archive only counts low
  -- ratings dated after this. See migration_unarchived_at.sql.
  unarchived_at TIMESTAMPTZ,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  -- TRUE for highlights read FROM a Notion page (they already exist there).
  -- The enqueue_notion_sync trigger skips the 'add' for these rows.
  imported_from_notion BOOLEAN NOT NULL DEFAULT FALSE,
  -- Per-edit opt-out marker for the "Don't sync to Notion" checkbox.
  notion_optout_marker TEXT,
  -- Normalized dedup hash; unique per user. See migration_dedupe_text_unique.sql.
  text_hash TEXT GENERATED ALWAYS AS (
    md5(lower(regexp_replace(trim(coalesce(text, '')), '\s+', ' ', 'g')))
  ) STORED
);

-- Create daily_summaries table
CREATE TABLE IF NOT EXISTS daily_summaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Create highlight categories junction table
CREATE TABLE IF NOT EXISTS highlight_categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(highlight_id, category_id)
);

-- Create highlight links table (for linking highlights together)
CREATE TABLE IF NOT EXISTS highlight_links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  to_highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  link_text TEXT, -- The text that was hyperlinked
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(from_highlight_id, to_highlight_id),
  CHECK (from_highlight_id != to_highlight_id)
);

-- Create junction table for daily summary highlights.
-- rating is TEXT ('low'/'med'/'high') — the app reads and writes these string
-- values everywhere (see migration_rating_to_text.sql). Do NOT revert to the
-- old INTEGER scale: every rating write would fail on a fresh install.
CREATE TABLE IF NOT EXISTS daily_summary_highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  daily_summary_id UUID NOT NULL REFERENCES daily_summaries(id) ON DELETE CASCADE,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  rating TEXT CONSTRAINT rating_values CHECK (rating IN ('low', 'med', 'high') OR rating IS NULL),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(daily_summary_id, highlight_id)
);

-- Create table to track which months each highlight has been reviewed
CREATE TABLE IF NOT EXISTS highlight_months_reviewed (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  month_year TEXT NOT NULL, -- Format: "YYYY-MM" e.g., "2026-01" for January 2026
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(highlight_id, month_year)
);

-- Create table to store user Notion settings
CREATE TABLE IF NOT EXISTS user_notion_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notion_api_key TEXT NOT NULL,
  notion_page_id TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Create table to store pending Notion sync operations.
-- highlight_id is a PLAIN column — deliberately no FK. An ON DELETE CASCADE
-- here raced the cancel-pending-add logic when a highlight was added then
-- deleted before syncing (see migration_drop_sync_queue_cascade.sql).
CREATE TABLE IF NOT EXISTS notion_sync_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  highlight_id UUID, -- Nullable for delete operations; no FK on purpose
  operation_type TEXT NOT NULL CHECK (operation_type IN ('add', 'update', 'delete')),
  text TEXT,
  html_content TEXT,
  original_text TEXT, -- Original text before update (for update operations)
  original_html_content TEXT, -- Original HTML before update (for update operations)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 5,
  error_message TEXT,
  last_retry_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE, -- When to retry failed items (exponential backoff)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE
);

-- Create pinned_highlights table (max 10 per user)
CREATE TABLE IF NOT EXISTS pinned_highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  pinned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, highlight_id)
);

-- ============================================================================
-- 2. ADD COLUMNS (for existing databases)
-- ============================================================================

-- Add user_id columns if they don't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'categories' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE categories ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'highlights' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE highlights ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'daily_summaries' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE daily_summaries ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'highlights' AND column_name = 'archived'
  ) THEN
    ALTER TABLE highlights ADD COLUMN archived BOOLEAN DEFAULT FALSE;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'notion_sync_queue' AND column_name = 'original_text'
  ) THEN
    ALTER TABLE notion_sync_queue ADD COLUMN original_text TEXT;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'notion_sync_queue' AND column_name = 'original_html_content'
  ) THEN
    ALTER TABLE notion_sync_queue ADD COLUMN original_html_content TEXT;
  END IF;
  
  -- Make highlight_id nullable for delete operations
  -- This allows delete operations to remain in the queue even after the highlight is deleted
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'notion_sync_queue' 
    AND column_name = 'highlight_id' 
    AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE notion_sync_queue ALTER COLUMN highlight_id DROP NOT NULL;
  END IF;
END $$;

-- Flag for highlights imported from Notion (skips the trigger's 'add' enqueue).
ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS imported_from_notion BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-edit opt-out marker for the "Don't sync to Notion" checkbox.
ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS notion_optout_marker TEXT;

-- Manual-unarchive timestamp (see migration_unarchived_at.sql).
ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS unarchived_at TIMESTAMPTZ;

-- Convert a legacy INTEGER rating column to the TEXT scale the app uses
-- (see migration_rating_to_text.sql — this is that migration, guarded so it
-- runs exactly once on databases still carrying the old 1-5 integer scale).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'daily_summary_highlights'
      AND column_name = 'rating'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE daily_summary_highlights ADD COLUMN rating_new TEXT;
    UPDATE daily_summary_highlights
    SET rating_new = CASE
      WHEN rating::text = '5' THEN 'high'
      WHEN rating::text = '4' THEN 'med'
      WHEN rating::text IN ('3', '2', '1') THEN 'low'
      ELSE NULL
    END;
    ALTER TABLE daily_summary_highlights DROP COLUMN rating;
    ALTER TABLE daily_summary_highlights RENAME COLUMN rating_new TO rating;
    ALTER TABLE daily_summary_highlights
      ADD CONSTRAINT rating_values CHECK (rating IN ('low', 'med', 'high') OR rating IS NULL);

    -- Recalculate averages on the new scale (low=1, med=2, high=3).
    UPDATE highlights h
    SET
      average_rating = sub.avg_rating,
      rating_count = sub.cnt
    FROM (
      SELECT
        dsh.highlight_id,
        AVG(CASE dsh.rating WHEN 'low' THEN 1 WHEN 'med' THEN 2 WHEN 'high' THEN 3 END) AS avg_rating,
        COUNT(dsh.rating) AS cnt
      FROM daily_summary_highlights dsh
      WHERE dsh.rating IS NOT NULL
      GROUP BY dsh.highlight_id
    ) sub
    WHERE h.id = sub.highlight_id;
  END IF;
END $$;

-- Drop the sync-queue FK cascade if an older install still has it
-- (see migration_drop_sync_queue_cascade.sql).
ALTER TABLE notion_sync_queue
  DROP CONSTRAINT IF EXISTS notion_sync_queue_highlight_id_fkey;

-- Normalized dedup hash + per-user uniqueness (see migration_dedupe_text_unique.sql).
-- The app's save path REQUIRES this: it upserts with onConflict 'user_id,text_hash'.
ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS text_hash TEXT GENERATED ALWAYS AS (
    md5(lower(regexp_replace(trim(coalesce(text, '')), '\s+', ' ', 'g')))
  ) STORED;

-- Remove duplicates (keep the oldest per user/text) before enforcing uniqueness.
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

ALTER TABLE highlights
  DROP CONSTRAINT IF EXISTS highlights_user_id_text_hash_key;
ALTER TABLE highlights
  ADD CONSTRAINT highlights_user_id_text_hash_key
  UNIQUE (user_id, text_hash);

-- Enforce NOT NULL on every user-owning column. A NULL user_id is invisible
-- under the `auth.uid() = user_id` RLS policies (it matches no caller), so an
-- orphan row is both a silent data loss and a sign of a write path that forgot
-- to set the owner. Skip per-table if orphan rows exist rather than erroring,
-- so this stays idempotent on dirty databases. See migration_user_id_not_null.sql.
DO $$
DECLARE
  v_orphans bigint;
  v_tbl     text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['highlights', 'daily_summaries', 'categories']
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE user_id IS NULL', v_tbl)
      INTO v_orphans;
    IF v_orphans = 0 THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id SET NOT NULL', v_tbl);
    ELSE
      RAISE WARNING '[user_id NOT NULL] % has % orphan row(s); leaving column nullable. Clean up and re-run.', v_tbl, v_orphans;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 3. CREATE INDEXES
-- ============================================================================

-- Basic indexes
CREATE INDEX IF NOT EXISTS idx_highlights_created_at ON highlights(created_at);
CREATE INDEX IF NOT EXISTS idx_highlights_last_resurfaced ON highlights(last_resurfaced);
CREATE INDEX IF NOT EXISTS idx_highlights_average_rating ON highlights(average_rating);
CREATE INDEX IF NOT EXISTS idx_highlights_archived ON highlights(archived);
CREATE INDEX IF NOT EXISTS idx_highlights_user_id ON highlights(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date);
CREATE INDEX IF NOT EXISTS idx_daily_summaries_user_id ON daily_summaries(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_summary_highlights_summary ON daily_summary_highlights(daily_summary_id);
CREATE INDEX IF NOT EXISTS idx_daily_summary_highlights_highlight ON daily_summary_highlights(highlight_id);
CREATE INDEX IF NOT EXISTS idx_highlight_categories_highlight ON highlight_categories(highlight_id);
CREATE INDEX IF NOT EXISTS idx_highlight_categories_category ON highlight_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_highlight_links_from ON highlight_links(from_highlight_id);
CREATE INDEX IF NOT EXISTS idx_highlight_links_to ON highlight_links(to_highlight_id);
CREATE INDEX IF NOT EXISTS idx_highlight_months_reviewed_highlight ON highlight_months_reviewed(highlight_id);
CREATE INDEX IF NOT EXISTS idx_highlight_months_reviewed_month ON highlight_months_reviewed(month_year);
CREATE INDEX IF NOT EXISTS idx_user_notion_settings_user_id ON user_notion_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_notion_sync_queue_user_id ON notion_sync_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_notion_sync_queue_status ON notion_sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_notion_sync_queue_created_at ON notion_sync_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_notion_sync_queue_highlight_id ON notion_sync_queue(highlight_id);
CREATE INDEX IF NOT EXISTS idx_notion_sync_queue_status_created ON notion_sync_queue(status, created_at) 
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_pinned_highlights_user ON pinned_highlights(user_id);
CREATE INDEX IF NOT EXISTS idx_pinned_highlights_highlight ON pinned_highlights(highlight_id);

-- Full-text search indexes (GIN indexes for PostgreSQL full-text search)
CREATE INDEX IF NOT EXISTS idx_highlights_text_gin ON highlights USING gin(to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS idx_highlights_html_content_gin ON highlights USING gin(to_tsvector('english', html_content));

-- ============================================================================
-- 4. UPDATE CONSTRAINTS
-- ============================================================================

-- Update unique constraint on categories to include user_id (categories are unique per user)
DO $$
BEGIN
  -- Drop old unique constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'categories_name_key' 
    AND conrelid = 'categories'::regclass
  ) THEN
    ALTER TABLE categories DROP CONSTRAINT categories_name_key;
  END IF;
  
  -- Add new unique constraint with user_id
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'categories_name_user_id_key' 
    AND conrelid = 'categories'::regclass
  ) THEN
    ALTER TABLE categories ADD CONSTRAINT categories_name_user_id_key UNIQUE (name, user_id);
  END IF;
END $$;

-- Update unique constraint on daily_summaries to include user_id (dates are unique per user)
DO $$
BEGIN
  -- Drop old unique constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'daily_summaries_date_key' 
    AND conrelid = 'daily_summaries'::regclass
  ) THEN
    ALTER TABLE daily_summaries DROP CONSTRAINT daily_summaries_date_key;
  END IF;
  
  -- Add new unique constraint with user_id
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'daily_summaries_date_user_id_key' 
    AND conrelid = 'daily_summaries'::regclass
  ) THEN
    ALTER TABLE daily_summaries ADD CONSTRAINT daily_summaries_date_user_id_key UNIQUE (date, user_id);
  END IF;
END $$;

-- ============================================================================
-- 5. ENABLE ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summary_highlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlight_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlight_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlight_months_reviewed ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notion_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notion_sync_queue ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 6. DROP OLD PERMISSIVE POLICIES (if they exist)
-- ============================================================================

DROP POLICY IF EXISTS "Allow all operations on categories" ON categories;
DROP POLICY IF EXISTS "Allow all operations on highlights" ON highlights;
DROP POLICY IF EXISTS "Allow all operations on daily_summaries" ON daily_summaries;
DROP POLICY IF EXISTS "Allow all operations on daily_summary_highlights" ON daily_summary_highlights;
DROP POLICY IF EXISTS "Allow all operations on highlight_categories" ON highlight_categories;
DROP POLICY IF EXISTS "Allow all operations on highlight_links" ON highlight_links;
DROP POLICY IF EXISTS "Allow all operations on highlight_months_reviewed" ON highlight_months_reviewed;
DROP POLICY IF EXISTS "Allow all operations on user_notion_settings" ON user_notion_settings;
DROP POLICY IF EXISTS "Allow all operations on notion_sync_queue" ON notion_sync_queue;

-- ============================================================================
-- 7. CREATE USER-SPECIFIC RLS POLICIES
-- ============================================================================

-- Categories policies
DROP POLICY IF EXISTS "Users can view their own categories" ON categories;
CREATE POLICY "Users can view their own categories" ON categories
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own categories" ON categories;
CREATE POLICY "Users can insert their own categories" ON categories
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own categories" ON categories;
CREATE POLICY "Users can update their own categories" ON categories
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own categories" ON categories;
CREATE POLICY "Users can delete their own categories" ON categories
  FOR DELETE USING (auth.uid() = user_id);

-- Highlights policies
DROP POLICY IF EXISTS "Users can view their own highlights" ON highlights;
CREATE POLICY "Users can view their own highlights" ON highlights
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own highlights" ON highlights;
CREATE POLICY "Users can insert their own highlights" ON highlights
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own highlights" ON highlights;
CREATE POLICY "Users can update their own highlights" ON highlights
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own highlights" ON highlights;
CREATE POLICY "Users can delete their own highlights" ON highlights
  FOR DELETE USING (auth.uid() = user_id);

-- Daily summaries policies
DROP POLICY IF EXISTS "Users can view their own daily_summaries" ON daily_summaries;
CREATE POLICY "Users can view their own daily_summaries" ON daily_summaries
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own daily_summaries" ON daily_summaries;
CREATE POLICY "Users can insert their own daily_summaries" ON daily_summaries
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own daily_summaries" ON daily_summaries;
CREATE POLICY "Users can update their own daily_summaries" ON daily_summaries
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own daily_summaries" ON daily_summaries;
CREATE POLICY "Users can delete their own daily_summaries" ON daily_summaries
  FOR DELETE USING (auth.uid() = user_id);

-- Daily summary highlights policies
DROP POLICY IF EXISTS "Users can view their own daily_summary_highlights" ON daily_summary_highlights;
CREATE POLICY "Users can view their own daily_summary_highlights" ON daily_summary_highlights
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM daily_summaries
      WHERE daily_summaries.id = daily_summary_highlights.daily_summary_id
      AND daily_summaries.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert their own daily_summary_highlights" ON daily_summary_highlights;
CREATE POLICY "Users can insert their own daily_summary_highlights" ON daily_summary_highlights
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM daily_summaries
      WHERE daily_summaries.id = daily_summary_highlights.daily_summary_id
      AND daily_summaries.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = daily_summary_highlights.highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update their own daily_summary_highlights" ON daily_summary_highlights;
CREATE POLICY "Users can update their own daily_summary_highlights" ON daily_summary_highlights
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM daily_summaries
      WHERE daily_summaries.id = daily_summary_highlights.daily_summary_id
      AND daily_summaries.user_id = auth.uid()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM daily_summaries
      WHERE daily_summaries.id = daily_summary_highlights.daily_summary_id
      AND daily_summaries.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete their own daily_summary_highlights" ON daily_summary_highlights;
CREATE POLICY "Users can delete their own daily_summary_highlights" ON daily_summary_highlights
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM daily_summaries
      WHERE daily_summaries.id = daily_summary_highlights.daily_summary_id
      AND daily_summaries.user_id = auth.uid()
    )
  );

-- Highlight categories policies
DROP POLICY IF EXISTS "Users can view their own highlight_categories" ON highlight_categories;
CREATE POLICY "Users can view their own highlight_categories" ON highlight_categories
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_categories.highlight_id
      AND highlights.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM categories
      WHERE categories.id = highlight_categories.category_id
      AND categories.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert their own highlight_categories" ON highlight_categories;
CREATE POLICY "Users can insert their own highlight_categories" ON highlight_categories
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_categories.highlight_id
      AND highlights.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM categories
      WHERE categories.id = highlight_categories.category_id
      AND categories.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update their own highlight_categories" ON highlight_categories;
CREATE POLICY "Users can update their own highlight_categories" ON highlight_categories
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_categories.highlight_id
      AND highlights.user_id = auth.uid()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_categories.highlight_id
      AND highlights.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM categories
      WHERE categories.id = highlight_categories.category_id
      AND categories.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete their own highlight_categories" ON highlight_categories;
CREATE POLICY "Users can delete their own highlight_categories" ON highlight_categories
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_categories.highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

-- Highlight links policies
DROP POLICY IF EXISTS "Users can view their own highlight_links" ON highlight_links;
CREATE POLICY "Users can view their own highlight_links" ON highlight_links
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_links.from_highlight_id
      AND highlights.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_links.to_highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert their own highlight_links" ON highlight_links;
CREATE POLICY "Users can insert their own highlight_links" ON highlight_links
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_links.from_highlight_id
      AND highlights.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_links.to_highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update their own highlight_links" ON highlight_links;
CREATE POLICY "Users can update their own highlight_links" ON highlight_links
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_links.from_highlight_id
      AND highlights.user_id = auth.uid()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_links.from_highlight_id
      AND highlights.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_links.to_highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete their own highlight_links" ON highlight_links;
CREATE POLICY "Users can delete their own highlight_links" ON highlight_links
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_links.from_highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

-- Highlight months reviewed policies
DROP POLICY IF EXISTS "Users can view their own highlight_months_reviewed" ON highlight_months_reviewed;
CREATE POLICY "Users can view their own highlight_months_reviewed" ON highlight_months_reviewed
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_months_reviewed.highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert their own highlight_months_reviewed" ON highlight_months_reviewed;
CREATE POLICY "Users can insert their own highlight_months_reviewed" ON highlight_months_reviewed
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_months_reviewed.highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update their own highlight_months_reviewed" ON highlight_months_reviewed;
CREATE POLICY "Users can update their own highlight_months_reviewed" ON highlight_months_reviewed
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_months_reviewed.highlight_id
      AND highlights.user_id = auth.uid()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_months_reviewed.highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete their own highlight_months_reviewed" ON highlight_months_reviewed;
CREATE POLICY "Users can delete their own highlight_months_reviewed" ON highlight_months_reviewed
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM highlights
      WHERE highlights.id = highlight_months_reviewed.highlight_id
      AND highlights.user_id = auth.uid()
    )
  );

-- User Notion settings policies
DROP POLICY IF EXISTS "Users can view their own notion settings" ON user_notion_settings;
CREATE POLICY "Users can view their own notion settings" ON user_notion_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own notion settings" ON user_notion_settings;
CREATE POLICY "Users can insert their own notion settings" ON user_notion_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own notion settings" ON user_notion_settings;
CREATE POLICY "Users can update their own notion settings" ON user_notion_settings
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own notion settings" ON user_notion_settings;
CREATE POLICY "Users can delete their own notion settings" ON user_notion_settings
  FOR DELETE USING (auth.uid() = user_id);

-- Create function to update updated_at timestamp for user_notion_settings
CREATE OR REPLACE FUNCTION update_user_notion_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS update_user_notion_settings_updated_at ON user_notion_settings;
CREATE TRIGGER update_user_notion_settings_updated_at
  BEFORE UPDATE ON user_notion_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_user_notion_settings_updated_at();

-- Notion sync queue policies
DROP POLICY IF EXISTS "Users can view their own sync queue items" ON notion_sync_queue;
CREATE POLICY "Users can view their own sync queue items" ON notion_sync_queue
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own sync queue items" ON notion_sync_queue;
CREATE POLICY "Users can insert their own sync queue items" ON notion_sync_queue
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own sync queue items" ON notion_sync_queue;
CREATE POLICY "Users can update their own sync queue items" ON notion_sync_queue
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own sync queue items" ON notion_sync_queue;
CREATE POLICY "Users can delete their own sync queue items" ON notion_sync_queue
  FOR DELETE USING (auth.uid() = user_id);

-- Pinned highlights policies
ALTER TABLE pinned_highlights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own pinned highlights" ON pinned_highlights;
CREATE POLICY "Users can view their own pinned highlights" ON pinned_highlights
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own pinned highlights" ON pinned_highlights;
CREATE POLICY "Users can insert their own pinned highlights" ON pinned_highlights
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own pinned highlights" ON pinned_highlights;
CREATE POLICY "Users can delete their own pinned highlights" ON pinned_highlights
  FOR DELETE USING (auth.uid() = user_id);

-- Function to enforce 10-pin limit
CREATE OR REPLACE FUNCTION enforce_pin_limit()
RETURNS TRIGGER AS $$
DECLARE
  pin_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO pin_count
  FROM pinned_highlights
  WHERE user_id = NEW.user_id;

  IF pin_count >= 10 THEN
    RAISE EXCEPTION 'Maximum of 10 pinned highlights allowed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_pin_limit ON pinned_highlights;
CREATE TRIGGER check_pin_limit
  BEFORE INSERT ON pinned_highlights
  FOR EACH ROW
  EXECUTE FUNCTION enforce_pin_limit();

-- Create function to update updated_at for notion_sync_queue
CREATE OR REPLACE FUNCTION update_notion_sync_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for notion_sync_queue updated_at
DROP TRIGGER IF EXISTS update_notion_sync_queue_updated_at ON notion_sync_queue;
CREATE TRIGGER update_notion_sync_queue_updated_at
  BEFORE UPDATE ON notion_sync_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_notion_sync_queue_updated_at();

-- ============================================================================
-- 9. ATOMIC NOTION-SYNC ENQUEUEING (see migration_notion_sync_trigger.sql)
-- ============================================================================
-- A highlight change and its notion_sync_queue row are written in ONE
-- transaction by this trigger, so the two tables can never disagree. This
-- replaces the old POST /api/notion/queue route. See the standalone migration
-- file for the full rationale.

CREATE OR REPLACE FUNCTION enqueue_notion_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid;
  v_notion_on   boolean;
  v_existing_id uuid;
  v_pending_add uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  -- Only enqueue when this user has Notion sync enabled.
  SELECT TRUE INTO v_notion_on
  FROM user_notion_settings
  WHERE user_id = v_user_id AND enabled = TRUE
  LIMIT 1;

  IF v_notion_on IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  -- INSERT -> 'add'
  IF TG_OP = 'INSERT' THEN
    IF NEW.imported_from_notion THEN
      RETURN NULL;  -- already on the Notion page; do not echo back
    END IF;

    INSERT INTO notion_sync_queue
      (user_id, highlight_id, operation_type, text, html_content,
       status, retry_count, max_retries)
    VALUES
      (NEW.user_id, NEW.id, 'add', NEW.text, NEW.html_content,
       'pending', 0, 5);

    RETURN NULL;
  END IF;

  -- UPDATE -> 'update' (WHEN clause guarantees text/html actually changed)
  IF TG_OP = 'UPDATE' THEN
    -- "Don't sync to Notion": this edit bumped the opt-out marker. Honour it.
    IF NEW.notion_optout_marker IS DISTINCT FROM OLD.notion_optout_marker THEN
      RETURN NULL;
    END IF;

    SELECT id INTO v_existing_id
    FROM notion_sync_queue
    WHERE user_id        = NEW.user_id
      AND highlight_id   = NEW.id
      AND operation_type = 'update'
      AND status         = 'pending'
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE notion_sync_queue
      SET text         = NEW.text,
          html_content = NEW.html_content
      WHERE id = v_existing_id;
    ELSE
      INSERT INTO notion_sync_queue
        (user_id, highlight_id, operation_type, text, html_content,
         original_text, original_html_content,
         status, retry_count, max_retries)
      VALUES
        (NEW.user_id, NEW.id, 'update', NEW.text, NEW.html_content,
         OLD.text, OLD.html_content,
         'pending', 0, 5);
    END IF;

    RETURN NULL;
  END IF;

  -- DELETE -> 'delete', or cancel a never-synced 'add'
  IF TG_OP = 'DELETE' THEN
    SELECT id INTO v_pending_add
    FROM notion_sync_queue
    WHERE user_id        = OLD.user_id
      AND highlight_id   = OLD.id
      AND operation_type = 'add'
      AND status         = 'pending'
      AND retry_count    = 0
    LIMIT 1;

    IF v_pending_add IS NOT NULL THEN
      DELETE FROM notion_sync_queue
      WHERE user_id        = OLD.user_id
        AND highlight_id   = OLD.id
        AND operation_type IN ('add', 'update')
        AND status         = 'pending'
        AND retry_count    = 0;

      RETURN NULL;
    END IF;

    INSERT INTO notion_sync_queue
      (user_id, highlight_id, operation_type, text, html_content,
       status, retry_count, max_retries)
    VALUES
      (OLD.user_id, NULL, 'delete', OLD.text, OLD.html_content,
       'pending', 0, 5);

    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_notion_sync_insert ON highlights;
CREATE TRIGGER enqueue_notion_sync_insert
  AFTER INSERT ON highlights
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_notion_sync();

DROP TRIGGER IF EXISTS enqueue_notion_sync_update ON highlights;
CREATE TRIGGER enqueue_notion_sync_update
  AFTER UPDATE ON highlights
  FOR EACH ROW
  WHEN (OLD.text IS DISTINCT FROM NEW.text
        OR OLD.html_content IS DISTINCT FROM NEW.html_content)
  EXECUTE FUNCTION enqueue_notion_sync();

DROP TRIGGER IF EXISTS enqueue_notion_sync_delete ON highlights;
CREATE TRIGGER enqueue_notion_sync_delete
  AFTER DELETE ON highlights
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_notion_sync();

-- ============================================================================
-- 9. PER-USER REVIEW FREQUENCY (monthly … yearly) + daily-review on/off switch
-- ============================================================================
-- See migration_review_frequency.sql for the standalone version + rationale.
-- highlight_months_reviewed.month_year is reinterpreted as a generic cycle key
-- (the cycle's start month). For frequency_months = 1 the cycle key IS the
-- calendar month, so existing rows stay valid with no data migration.

CREATE TABLE IF NOT EXISTS user_review_settings (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  frequency_months     INTEGER NOT NULL DEFAULT 1
                       CHECK (frequency_months >= 1 AND frequency_months <= 12),
  daily_review_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE user_review_settings
  ADD COLUMN IF NOT EXISTS daily_review_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE user_review_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own review settings" ON user_review_settings;
CREATE POLICY "Users can view their own review settings" ON user_review_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own review settings" ON user_review_settings;
CREATE POLICY "Users can insert their own review settings" ON user_review_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own review settings" ON user_review_settings;
CREATE POLICY "Users can update their own review settings" ON user_review_settings
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own review settings" ON user_review_settings;
CREATE POLICY "Users can delete their own review settings" ON user_review_settings
  FOR DELETE USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION update_user_review_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_review_settings_updated_at ON user_review_settings;
CREATE TRIGGER update_user_review_settings_updated_at
  BEFORE UPDATE ON user_review_settings
  FOR EACH ROW EXECUTE FUNCTION update_user_review_settings_updated_at();

-- ============================================================================
-- 10. REVIEW-AHEAD FROZEN ORDER (see migration_review_ahead_order.sql)
-- ============================================================================
-- Server-side home for the frozen review-ahead sequence (lib/aheadOrder.ts).
-- One row per user per cycle; `ids` is the ordered highlight_id sequence.

CREATE TABLE IF NOT EXISTS review_ahead_order (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cycle_key TEXT NOT NULL,
  ids JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (user_id, cycle_key)
);

ALTER TABLE review_ahead_order ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own ahead order" ON review_ahead_order;
CREATE POLICY "Users can view their own ahead order" ON review_ahead_order
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own ahead order" ON review_ahead_order;
CREATE POLICY "Users can insert their own ahead order" ON review_ahead_order
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own ahead order" ON review_ahead_order;
CREATE POLICY "Users can update their own ahead order" ON review_ahead_order
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own ahead order" ON review_ahead_order;
CREATE POLICY "Users can delete their own ahead order" ON review_ahead_order
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- 11. RESURFACE STATS TRIGGERS (see migration_resurface_stats.sql)
-- ============================================================================
-- resurface_count = number of distinct cycles the highlight has been rated in;
-- last_resurfaced = most recent timestamp a rating was set.

CREATE OR REPLACE FUNCTION update_resurface_count_from_hmr()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE highlights
  SET resurface_count = (
    SELECT COUNT(*)
    FROM highlight_months_reviewed
    WHERE highlight_id = NEW.highlight_id
  )
  WHERE id = NEW.highlight_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_resurface_count_on_hmr ON highlight_months_reviewed;
CREATE TRIGGER trigger_resurface_count_on_hmr
AFTER INSERT OR UPDATE ON highlight_months_reviewed
FOR EACH ROW
EXECUTE FUNCTION update_resurface_count_from_hmr();

CREATE OR REPLACE FUNCTION bump_last_resurfaced_on_rating()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.rating IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.rating IS NOT DISTINCT FROM NEW.rating THEN
    RETURN NEW;
  END IF;
  UPDATE highlights
  SET last_resurfaced = NOW()
  WHERE id = NEW.highlight_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_bump_last_resurfaced_on_rating ON daily_summary_highlights;
CREATE TRIGGER trigger_bump_last_resurfaced_on_rating
AFTER INSERT OR UPDATE OF rating ON daily_summary_highlights
FOR EACH ROW
EXECUTE FUNCTION bump_last_resurfaced_on_rating();

-- Backfill both fields from existing data (idempotent recompute; noon-UTC
-- anchor so local rendering lands on the right calendar day — see
-- migration_fix_last_resurfaced_tz.sql).
UPDATE highlights h
SET resurface_count = COALESCE(stats.cnt, 0)
FROM (
  SELECT highlight_id, COUNT(DISTINCT month_year) AS cnt
  FROM (
    SELECT highlight_id, month_year FROM highlight_months_reviewed
    UNION
    SELECT dsh.highlight_id, to_char(ds.date, 'YYYY-MM') AS month_year
    FROM daily_summary_highlights dsh
    JOIN daily_summaries ds ON ds.id = dsh.daily_summary_id
    WHERE dsh.rating IS NOT NULL
  ) all_months
  GROUP BY highlight_id
) stats
WHERE h.id = stats.highlight_id;

UPDATE highlights h
SET last_resurfaced = stats.last_rated
FROM (
  SELECT dsh.highlight_id,
         (MAX(ds.date)::timestamp + interval '12 hours') AT TIME ZONE 'UTC' AS last_rated
  FROM daily_summary_highlights dsh
  JOIN daily_summaries ds ON ds.id = dsh.daily_summary_id
  WHERE dsh.rating IS NOT NULL
  GROUP BY dsh.highlight_id
) stats
WHERE h.id = stats.highlight_id
  AND h.last_resurfaced IS NULL;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- The database is now fully set up with:
-- - All tables created with user_id columns
-- - Archived column on highlights
-- - Full-text search indexes
-- - Row Level Security enabled
-- - User-specific RLS policies
-- - Notion sync queue for background processing
-- - Original text tracking in sync queue (for update operations)
-- ============================================================================

