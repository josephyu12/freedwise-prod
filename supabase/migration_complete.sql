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
  average_rating DECIMAL(3,2) DEFAULT 0, -- Average of all ratings (1-5 scale)
  rating_count INTEGER DEFAULT 0,
  archived BOOLEAN DEFAULT FALSE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
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

-- Create junction table for daily summary highlights
CREATE TABLE IF NOT EXISTS daily_summary_highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  daily_summary_id UUID NOT NULL REFERENCES daily_summaries(id) ON DELETE CASCADE,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5), -- Rating given in this daily summary (1-5 scale: low=1, med=3, high=5)
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

-- Create table to store pending Notion sync operations
CREATE TABLE IF NOT EXISTS notion_sync_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  highlight_id UUID REFERENCES highlights(id) ON DELETE CASCADE, -- Nullable for delete operations
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

