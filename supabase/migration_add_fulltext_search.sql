-- Migration: Add full-text search support
-- Run this in your Supabase SQL editor to enable full-text search

-- Create a GIN index for full-text search on the text column
-- This will significantly speed up text searches
CREATE INDEX IF NOT EXISTS idx_highlights_text_gin ON highlights USING gin(to_tsvector('english', text));

-- Create a GIN index for full-text search on html_content column
CREATE INDEX IF NOT EXISTS idx_highlights_html_content_gin ON highlights USING gin(to_tsvector('english', html_content));

-- Note: The above indexes use PostgreSQL's built-in full-text search capabilities.
-- They will automatically be used when you perform text searches using tsvector/tsquery.
-- For simple ILIKE searches (which we're using in the API), these indexes won't be used,
-- but they're here for future enhancement if you want to use more advanced full-text search.

-- Alternative: If you want to use ILIKE with better performance, you can create a trigram index:
-- First enable the extension: CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Then: CREATE INDEX IF NOT EXISTS idx_highlights_text_trgm ON highlights USING gin(text gin_trgm_ops);
-- And: CREATE INDEX IF NOT EXISTS idx_highlights_html_content_trgm ON highlights USING gin(html_content gin_trgm_ops);

