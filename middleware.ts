import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  // Allow cron job endpoints to bypass authentication
  const pathname = request.nextUrl.pathname
  if (pathname.startsWith('/api/daily/prepare-next-month') ||
      pathname.startsWith('/api/notion/auto-import') ||
      pathname.startsWith('/api/review/widget') ||
      pathname.startsWith('/api/widget-token')) {
    // Always allow cron endpoints through - they handle their own authentication
    // The route handlers will check for x-vercel-cron header or CRON_SECRET
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
     * Feel free to modify this pattern to include more paths.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

