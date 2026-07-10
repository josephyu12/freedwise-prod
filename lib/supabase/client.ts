import { createBrowserClient } from '@supabase/ssr'
import { Database } from '@/types/database'

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        // Bound every request: on a dead-but-connected network the platform
        // fetch can hang for 60s+, freezing a rating/edit before the checked
        // error finally falls through to the offline queue. 15s covers slow
        // real connections while keeping the failure path responsive. Respect
        // a caller-provided signal; skip on browsers without AbortSignal.timeout.
        fetch: (input, init) => {
          const timeout =
            typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
              ? AbortSignal.timeout(15_000)
              : undefined
          return fetch(input, { ...init, signal: init?.signal ?? timeout })
        },
      },
    }
  )
}

