import { NextResponse } from 'next/server'

// Lightweight health check endpoint for connectivity detection.
// No auth required — just returns 200 OK.
export async function GET() {
  return NextResponse.json({ ok: true }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
