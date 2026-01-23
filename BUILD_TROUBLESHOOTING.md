# Build Troubleshooting Guide

## Common Build Issues

### 1. Deprecation Warnings
The npm warnings you see (like `rimraf@3.0.2`, `eslint@8.57.1`, etc.) are just deprecation warnings. They **do not prevent deployment**. These are informational messages about packages that will be updated in the future.

### 2. Actual Build Errors
If the build is actually failing, you'll see error messages after the warnings. Common issues:

#### Missing Environment Variables
Make sure all required environment variables are set in your deployment platform (Vercel, etc.):

```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_key
# OR
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key

# For Notion integration (optional)
NOTION_API_KEY=your_notion_key
NOTION_PAGE_ID=your_page_id
CRON_SECRET=your_cron_secret
```

#### TypeScript Errors
Run locally to check for TypeScript errors:
```bash
npm run build
```

This will show any TypeScript compilation errors.

#### Import Path Issues
All API routes should use direct Supabase client creation, not import from `@/lib/supabase` (which is for client-side only).

### 3. Checking Build Logs
If deploying to Vercel:
1. Go to your project dashboard
2. Click on the failed deployment
3. Check the "Build Logs" tab
4. Look for actual error messages (not just warnings)

### 4. Local Build Test
Test the build locally before deploying:
```bash
# Install dependencies
npm install

# Run build
npm run build

# If successful, test production build
npm start
```

### 5. Common Fixes

#### Update Dependencies
```bash
npm update
```

#### Clear Cache
```bash
rm -rf .next
rm -rf node_modules
npm install
npm run build
```

#### Check Node Version
Make sure you're using Node.js 18+ (check in Vercel project settings).

## If Build Still Fails

1. **Check the full build log** - The error message will tell you exactly what's wrong
2. **Verify environment variables** - All `NEXT_PUBLIC_*` variables must be set
3. **Check TypeScript errors** - Run `npm run build` locally
4. **Verify imports** - Make sure all imports are correct and files exist

## Getting Help

If you're still having issues, share:
- The full build error message (not just warnings)
- Your Node.js version
- Your deployment platform (Vercel, etc.)
- Any TypeScript errors from local build

