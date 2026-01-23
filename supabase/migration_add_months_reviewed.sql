-- Migration: Add highlight_months_reviewed table
-- Run this in your Supabase SQL editor to add the months reviewed tracking

-- Create table to track which months each highlight has been reviewed
CREATE TABLE IF NOT EXISTS highlight_months_reviewed (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  month_year TEXT NOT NULL, -- Format: "YYYY-MM" e.g., "2026-01" for January 2026
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(highlight_id, month_year)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_highlight_months_reviewed_highlight ON highlight_months_reviewed(highlight_id);
CREATE INDEX IF NOT EXISTS idx_highlight_months_reviewed_month ON highlight_months_reviewed(month_year);

-- Enable Row Level Security (RLS)
ALTER TABLE highlight_months_reviewed ENABLE ROW LEVEL SECURITY;

-- Create policy (adjust based on your auth needs)
CREATE POLICY "Allow all operations on highlight_months_reviewed" ON highlight_months_reviewed
  FOR ALL USING (true) WITH CHECK (true);

