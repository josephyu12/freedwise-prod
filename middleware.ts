import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  // Static public files and cron/widget endpoints must not wait on
  // supabase.auth.getUser(). /sw.js was matching the old matcher, so a hung
  // Auth fetch 504'd the service worker as well as the document.
  if (
    pathname === '/sw.js' ||
    pathname.startsWith('/api/daily/prepare-next-cycle') ||
    pathname.startsWith('/api/review/widget')
  ) {
    return NextResponse.next()
  }
  
  // For all other routes, use normal session update
  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - sw.js / other public *.js (service worker, widget script)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js)$).*)',
  ],
}

