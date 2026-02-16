import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import crypto from 'crypto'

// Signs a user ID with HMAC to create a long-lived widget token
// Token format: userId.signature
function createWidgetToken(userId: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const signature = crypto
    .createHmac('sha256', secret)
    .update(userId)
    .digest('hex')
  return `${userId}.${signature}`
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
