# Supabase API Keys Setup

This project uses Supabase for the backend. Supabase has updated their API key system. This guide explains how to set up your API keys correctly.

## New vs Legacy Keys

Supabase now recommends using **publishable keys** instead of the legacy JWT-based `anon` keys. Both work, but publishable keys offer better security and easier rotation.

### Publishable Keys (Recommended)
- Format: `sb_publishable_...`
- Safe to expose in client-side code
- Easier to rotate without downtime
- Better security practices

### Legacy Anon Keys
- JWT-based (long-lived tokens)
- Still supported but being phased out
- Harder to rotate (can cause downtime)

## Where to Find Your Keys

1. Go to your Supabase project dashboard
2. Navigate to **Settings** → **API Keys**
3. For new keys: Copy the **Publishable key** from the API Keys tab
4. For legacy keys: Copy the `anon` key from the **Legacy API Keys** tab

## Environment Variables

This project supports both naming conventions:

```bash
# Recommended (new publishable key)
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...

# OR (legacy support)
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

The code in `lib/supabase.ts` will automatically use whichever one you provide.

## Security Notes

- **Publishable keys are safe to expose** in client-side code (browsers, mobile apps)
- They provide basic DoS protection and bill protection
- **Row Level Security (RLS)** is still your main protection - make sure it's enabled on all tables
- Never use secret keys (`sb_secret_...`) or `service_role` keys in client-side code

## More Information

For detailed information about API keys, see the [official Supabase documentation](https://supabase.com/docs/guides/api/api-keys).

