import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/types/database'
import { withDeadline } from '@/lib/withDeadline'

// Vercel Edge middleware is killed at 25s (MIDDLEWARE_INVOCATION_TIMEOUT /
// 504) if we do not return a Response. getUser() hits Supabase Auth when a
// session cookie is present. Two things have to be true:
//
//  1. We MUST return by MIDDLEWARE_GET_USER_DEADLINE_MS even if getUser
//     never settles (fetch ignoring abort). That is the 504 guarantee.
//  2. We still abort + answer a non-retryable 401 so auth-js's refresh
//     loop (abort is AuthRetryableFetchError, backoff ~30s) actually
//     exits instead of holding the isolate after we return.
//
// The 401 makes auth-js call _removeSession(). Fail-open MUST forward the
// original Cookie header and omit those Set-Cookie deletions, or a blip
// logs the user out.
export const MIDDLEWARE_FETCH_TIMEOUT_MS = 4_000
export const MIDDLEWARE_GET_USER_DEADLINE_MS = 8_000

function composeSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort()
      break
    }
    s.addEventListener('abort', onAbort)
  }
  const stop = () => signals.forEach((s) => s.removeEventListener('abort', onAbort))
  ctrl.signal.addEventListener('abort', stop, { once: true })
  return ctrl.signal
}

function middlewareFetch(opts: {
  timedOut: { value: boolean }
  deadline: AbortSignal
}): typeof fetch {
  return (input, init) => {
    // Non-retryable: auth-js only keeps looping on AuthRetryableFetchError
    // (abort, network, 502/503/504). A 401 stops _refreshAccessToken.
    if (opts.timedOut.value || opts.deadline.aborted) {
      return Promise.resolve(new Response('{}', { status: 401 }))
    }

    const extra: AbortSignal[] = [opts.deadline]
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
      extra.push(AbortSignal.timeout(MIDDLEWARE_FETCH_TIMEOUT_MS))
    }
    if (init?.signal) extra.push(init.signal)

    return fetch(input, { ...init, signal: composeSignals(extra) })
  }
}

function isRetryableAuthError(error: { name?: string } | null | undefined): boolean {
  return error?.name === 'AuthRetryableFetchError'
}

function passthroughWithOriginalCookies(
  request: NextRequest,
  originalCookie: string | null
): NextResponse {
  const headers = new Headers(request.headers)
  if (originalCookie === null) headers.delete('cookie')
  else headers.set('cookie', originalCookie)
  return NextResponse.next({ request: { headers } })
}

export async function updateSession(request: NextRequest) {
  const originalCookie = request.headers.get('cookie')
  let supabaseResponse = NextResponse.next({
    request,
  })

  const timedOut = { value: false }
  const deadlineCtrl = new AbortController()
  const deadlineTimer = setTimeout(() => {
    timedOut.value = true
    deadlineCtrl.abort()
  }, MIDDLEWARE_GET_USER_DEADLINE_MS)

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: middlewareFetch({ timedOut, deadline: deadlineCtrl.signal }) },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  let user = null
  try {
    // withDeadline is the 504 guarantee: we return even if getUser hangs.
    // Abort/401 below (deadlineTimer) is what stops leftover auth-js work.
    const { data, error } = await withDeadline(
      supabase.auth.getUser(),
      'middleware getUser',
      MIDDLEWARE_GET_USER_DEADLINE_MS
    )
    // Fail-open only when Auth was unreachable. AuthSessionMissingError is
    // the normal anonymous result and MUST still redirect to /login.
    // Do not return supabaseResponse here: a deadline 401 triggers
    // _removeSession and would Set-Cookie the session to empty.
    if (timedOut.value || isRetryableAuthError(error)) {
      return passthroughWithOriginalCookies(request, originalCookie)
    }
    user = data.user
  } catch {
    return passthroughWithOriginalCookies(request, originalCookie)
  } finally {
    timedOut.value = true
    deadlineCtrl.abort()
    clearTimeout(deadlineTimer)
  }

  if (
    !user &&
    !request.nextUrl.pathname.startsWith('/login') &&
    !request.nextUrl.pathname.startsWith('/auth') &&
    !request.nextUrl.pathname.startsWith('/terms') &&
    !request.nextUrl.pathname.startsWith('/privacy')
  ) {
    // no user, potentially respond by redirecting the user to the login page
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is. If you're
  // creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  // 4. Finally:
  //    return myNewResponse
  // If this is not done, you may be causing the browser and server to go out
  // of sync and terminate the user's session prematurely.

  return supabaseResponse
}
