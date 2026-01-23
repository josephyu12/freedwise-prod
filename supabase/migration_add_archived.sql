-- Migration: Add archived field to highlights table
-- Run this in your Supabase SQL editor to add archiving functionality

-- Add archived column to highlights table
ALTER TABLE highlights 
ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

-- Create index for archived highlights
CREATE INDEX IF NOT EXISTS idx_highlights_archived ON highlights(archived);

