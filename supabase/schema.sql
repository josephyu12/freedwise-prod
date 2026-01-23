-- Create categories table
CREATE TABLE categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#3B82F6',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create highlights table
CREATE TABLE highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  text TEXT NOT NULL,
  html_content TEXT, -- Rich text HTML content
  source TEXT,
  author TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_resurfaced TIMESTAMP WITH TIME ZONE,
  resurface_count INTEGER DEFAULT 0,
  average_rating DECIMAL(3,2) DEFAULT 0, -- Average of all ratings (0-2, where 0=low, 1=med, 2=high)
  rating_count INTEGER DEFAULT 0
);

-- Create daily_summaries table
CREATE TABLE daily_summaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create highlight categories junction table
CREATE TABLE highlight_categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(highlight_id, category_id)
);

-- Create highlight links table (for linking highlights together)
CREATE TABLE highlight_links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  to_highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  link_text TEXT, -- The text that was hyperlinked
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(from_highlight_id, to_highlight_id),
  CHECK (from_highlight_id != to_highlight_id)
);

-- Create junction table for daily summary highlights
CREATE TABLE daily_summary_highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  daily_summary_id UUID NOT NULL REFERENCES daily_summaries(id) ON DELETE CASCADE,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  rating TEXT CHECK (rating IN ('low', 'med', 'high')), -- Rating given in this daily summary
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(daily_summary_id, highlight_id)
);

-- Create table to track which months each highlight has been reviewed
CREATE TABLE highlight_months_reviewed (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  month_year TEXT NOT NULL, -- Format: "YYYY-MM" e.g., "2026-01" for January 2026
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(highlight_id, month_year)
);

-- Create indexes for better performance
CREATE INDEX idx_highlights_created_at ON highlights(created_at);
CREATE INDEX idx_highlights_last_resurfaced ON highlights(last_resurfaced);
CREATE INDEX idx_highlights_average_rating ON highlights(average_rating);
CREATE INDEX idx_daily_summaries_date ON daily_summaries(date);
CREATE INDEX idx_daily_summary_highlights_summary ON daily_summary_highlights(daily_summary_id);
CREATE INDEX idx_daily_summary_highlights_highlight ON daily_summary_highlights(highlight_id);
CREATE INDEX idx_highlight_categories_highlight ON highlight_categories(highlight_id);
CREATE INDEX idx_highlight_categories_category ON highlight_categories(category_id);
CREATE INDEX idx_highlight_links_from ON highlight_links(from_highlight_id);
CREATE INDEX idx_highlight_links_to ON highlight_links(to_highlight_id);
CREATE INDEX idx_highlight_months_reviewed_highlight ON highlight_months_reviewed(highlight_id);
CREATE INDEX idx_highlight_months_reviewed_month ON highlight_months_reviewed(month_year);

-- Enable Row Level Security (RLS)
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summary_highlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlight_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlight_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlight_months_reviewed ENABLE ROW LEVEL SECURITY;

-- Create policies (adjust based on your auth needs)
-- For now, allow all operations (you may want to restrict based on user_id)
CREATE POLICY "Allow all operations on categories" ON categories
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on highlights" ON highlights
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on daily_summaries" ON daily_summaries
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on daily_summary_highlights" ON daily_summary_highlights
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on highlight_categories" ON highlight_categories
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on highlight_links" ON highlight_links
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on highlight_months_reviewed" ON highlight_months_reviewed
  FOR ALL USING (true) WITH CHECK (true);

