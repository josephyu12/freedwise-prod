# Readwise Clone

A web application that resurfaces your highlights in daily summaries, built with Next.js, Tailwind CSS, and Supabase.

## Features

- **Rich Text Highlights**: Add highlights with formatting support (bold, italic, underline, bullet points, numbered lists)
- **Notion Import**: Import highlights from Notion pages - each empty line becomes a new highlight, with rich text formatting preserved
- **Category Tags**: Organize highlights with custom category tags
- **Highlight Linking**: Link highlights together with hyperlinked text references
- **Rating System**: Rate highlights (high/med/low) in daily summaries
- **Automatic Archiving**: Highlights marked as "low" twice are automatically archived and excluded from daily reviews
- **Monthly Review**: Every highlight appears once per month in daily summaries
- **Daily Summaries**: View resurfaced highlights organized by date
- **Modern UI**: Responsive design with dark mode support

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set up Supabase:
   - Create a new project at [supabase.com](https://supabase.com)
   - Get your project URL and API key from the project settings
   - **Recommended**: Use the new **Publishable key** (`sb_publishable_...`) from the API Keys section
   - **Alternative**: You can also use the legacy `anon` key (JWT-based), but publishable keys are recommended

3. Create environment variables:
   - Create a `.env.local` file in the root directory
   - Add the following:
   ```
   NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
   # OR use the legacy name (both work):
   # NEXT_PUBLIC_SUPABASE_ANON_KEY=your_publishable_key_or_anon_key
   ```
   
   **Optional - For automatic daily imports from Notion:**
   ```
   NOTION_API_KEY=your_notion_api_key
   NOTION_PAGE_ID=your_notion_page_id
   NOTION_SOURCE=optional_source_name
   NOTION_AUTHOR=optional_author_name
   CRON_SECRET=your_random_secret_string
   ```
   
   **Note**: The code supports both `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (recommended) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (legacy) for backward compatibility. Both work with new publishable keys and legacy anon keys.
   
   **Where to find your keys**:
   - Go to your Supabase project → Settings → API Keys
   - For new keys: Copy the **Publishable key** (starts with `sb_publishable_...`)
   - For legacy keys: Copy the `anon` key from the **Legacy API Keys** tab

4. Set up the database schema:
   - Run the SQL script in `supabase/schema.sql` in your Supabase SQL editor
   - If you already have the database set up, run these migration scripts in order:
     - `supabase/migration_add_months_reviewed.sql` - Adds months reviewed tracking
     - `supabase/migration_add_archived.sql` - Adds archiving functionality

5. Install dependencies (including PDF parsing library):
```bash
npm install
```

6. Run the development server:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Database Schema

The application uses the following tables:
- `highlights`: Stores your highlights with rich text content, ratings, metadata, and archived status
- `categories`: Stores category tags for organizing highlights
- `highlight_categories`: Junction table linking highlights to categories
- `highlight_links`: Stores links between highlights
- `highlight_months_reviewed`: Tracks which months each highlight has been reviewed
- `daily_summaries`: Stores daily summary records
- `daily_summary_highlights`: Junction table linking summaries to highlights with ratings

See `supabase/schema.sql` for the complete schema.

## Usage

### Adding Highlights
1. Go to the Highlights page
2. Use the rich text editor to format your highlight (bold, italic, underline, lists)
3. Optionally add source, author, and category tags
4. Click "Add Highlight"

### Importing Highlights from Notion
1. Go to the Import page (or click "Import PDF" from the Highlights page)
2. Get your Notion API key from [notion.so/my-integrations](https://www.notion.so/my-integrations) (create a new integration)
3. Get your Notion Page ID from the page URL (the long string after the last dash)
4. Enter your API key and Page ID
5. Click "Fetch Highlights from Notion" to preview the highlights
6. Each empty line (blank paragraph) in your Notion page will create a new highlight
7. Rich text formatting (bold, italic, underline, lists) will be preserved
8. Optionally add source and author information (applied to all imported highlights)
9. Click "Import" to add them to your database

### Linking Highlights
1. Click "Link Highlights" button
2. Select text in one highlight
3. Click another highlight to create a link
4. Linked highlights will show clickable references

### Rating Highlights
1. Go to the Daily Summary page
2. View your resurfaced highlights
3. Click Low/Med/High to rate each highlight
4. If a highlight is marked as "low" twice, it will be automatically archived
5. Archived highlights no longer appear in daily reviews but can be viewed and unarchived from the Highlights page

### Viewing Archived Highlights
1. Go to the Highlights page
2. Click "Show Archived" to view archived highlights
3. Click "Unarchive" on any archived highlight to restore it to active status

### Automatic Daily Imports from Notion
Set up automatic daily imports from your Notion page. See `AUTO_IMPORT_SETUP.md` for detailed instructions.

**Quick setup for Vercel:**
1. Set environment variables in Vercel dashboard:
   - `NOTION_API_KEY`
   - `NOTION_PAGE_ID`
   - `CRON_SECRET` (optional but recommended)
2. Deploy to Vercel - the cron job is already configured in `vercel.json`
3. Imports will run daily at midnight UTC

