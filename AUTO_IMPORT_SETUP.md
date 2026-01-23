# Automatic Daily Notion Import Setup

This guide explains how to set up automatic daily imports from Notion.

## Option 1: Vercel Cron (Recommended for Vercel deployments)

If you're deploying to Vercel, this is the easiest option.

### Steps:

1. **Set Environment Variables in Vercel:**
   - Go to your Vercel project → Settings → Environment Variables
   - Add the following:
     ```
     NOTION_API_KEY=your_notion_api_key_here
     NOTION_PAGE_ID=your_notion_page_id_here
     NOTION_SOURCE=optional_source_name
     NOTION_AUTHOR=optional_author_name
     CRON_SECRET=your_random_secret_string_here
     ```

2. **Deploy to Vercel:**
   - The `vercel.json` file is already configured
   - Push your code to trigger a deployment
   - Vercel will automatically set up the cron job

3. **Verify the Cron Job:**
   - Go to Vercel Dashboard → Your Project → Settings → Cron Jobs
   - You should see the job scheduled to run daily at midnight UTC

### Schedule Format:
- Current schedule: `0 9 * * *` (daily at 9:00 AM UTC = 4:00 AM EST/EDT)
- To change: Edit `vercel.json` and use [cron syntax](https://crontab.guru/)

**Common timezone conversions for 4am local time:**
- **EST (UTC-5)**: `0 9 * * *` (4am EST = 9am UTC)
- **PST (UTC-8)**: `0 12 * * *` (4am PST = 12pm UTC)
- **CST (UTC-6)**: `0 10 * * *` (4am CST = 10am UTC)
- **MST (UTC-7)**: `0 11 * * *` (4am MST = 11am UTC)
- **GMT/UTC**: `0 4 * * *` (4am UTC)

To find your timezone offset, check [timeanddate.com](https://www.timeanddate.com/worldclock/converter.html)

## Option 2: GitHub Actions (For any deployment)

If you're not using Vercel, you can use GitHub Actions.

### Steps:

1. **Create `.github/workflows/daily-import.yml`:**

```yaml
name: Daily Notion Import

on:
  schedule:
    - cron: '0 0 * * *'  # Daily at midnight UTC
  workflow_dispatch:  # Allow manual trigger

jobs:
  import:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Import
        run: |
          curl -X GET "${{ secrets.APP_URL }}/api/notion/auto-import?secret=${{ secrets.CRON_SECRET }}"
```

2. **Set GitHub Secrets:**
   - Go to your GitHub repo → Settings → Secrets and variables → Actions
   - Add:
     - `APP_URL`: Your deployed app URL (e.g., `https://your-app.vercel.app`)
     - `CRON_SECRET`: A random secret string

3. **Set Environment Variables in your hosting platform:**
   - Add `NOTION_API_KEY`, `NOTION_PAGE_ID`, etc. to your hosting platform

## Option 3: External Cron Service

Use a service like [cron-job.org](https://cron-job.org) or [EasyCron](https://www.easycron.com).

### Steps:

1. **Set up the API endpoint:**
   - Make sure your app is deployed and accessible
   - The endpoint is: `GET /api/notion/auto-import?secret=YOUR_CRON_SECRET`

2. **Configure the cron service:**
   - URL: `https://your-app-domain.com/api/notion/auto-import?secret=YOUR_CRON_SECRET`
   - Schedule: Daily at your preferred time
   - Method: GET

3. **Set environment variables** in your hosting platform

## Option 4: Supabase Edge Functions with pg_cron

If you're using Supabase, you can use Edge Functions with pg_cron.

### Steps:

1. **Create Edge Function** (see Supabase docs for setup)
2. **Set up pg_cron** to call the function daily
3. **Store credentials** in Supabase secrets

## Security Notes

- **CRON_SECRET**: Always set this to prevent unauthorized access to your import endpoint
- **Notion API Key**: Keep this secure and never commit it to git
- The endpoint checks for the secret in:
  - Authorization header: `Bearer YOUR_SECRET`
  - Query parameter: `?secret=YOUR_SECRET`

## Testing

You can manually trigger the import by calling:
```bash
curl -X GET "https://your-app.com/api/notion/auto-import?secret=YOUR_CRON_SECRET"
```

Or visit the URL in your browser (if CRON_SECRET is not set, it will still work but is less secure).

## Environment Variables Summary

Required:
- `NOTION_API_KEY`: Your Notion integration API key
- `NOTION_PAGE_ID`: The Notion page ID to import from

Optional:
- `NOTION_SOURCE`: Source name applied to imported highlights
- `NOTION_AUTHOR`: Author name applied to imported highlights
- `CRON_SECRET`: Secret to protect the auto-import endpoint

