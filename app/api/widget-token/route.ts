import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import crypto from 'crypto'

// Signs a user ID with HMAC to create a widget token with 90-day expiry
// Token format: userId.expiryTimestamp.signature
function createWidgetToken(userId: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const expiryTimestamp = Date.now() + (90 * 24 * 60 * 60 * 1000) // 90 days
  const payload = `${userId}.${expiryTimestamp}`
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
  return `${payload}.${signature}`
}

// GET: Generate a widget token for the authenticated user
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error } = await supabase.auth.getUser()

    if (error || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = createWidgetToken(user.id)
    return NextResponse.json({ token })
  } catch (error: any) {
    console.error('Error generating widget token:', error)
    return NextResponse.json(
      { error: 'Failed to generate token' },
      { status: 500 }
    )
  }
}
