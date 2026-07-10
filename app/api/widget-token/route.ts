import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createWidgetToken } from '@/lib/widgetToken'

// The user's current token version (see lib/widgetToken.ts). Missing row —
// or the table not migrated yet — reads as version 1.
async function currentTokenVersion(supabase: any, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('user_widget_settings')
    .select('token_version')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    const code = (error as { code?: string })?.code
    if (code === '42P01' || code === 'PGRST205') return 1
    throw error
  }
  return (data as { token_version?: number } | null)?.token_version ?? 1
}

// GET: Generate a widget token for the authenticated user
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error } = await supabase.auth.getUser()

    if (error || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const version = await currentTokenVersion(supabase, user.id)
    return NextResponse.json({ token: createWidgetToken(user.id, version) })
  } catch (error: any) {
    console.error('Error generating widget token:', error)
    return NextResponse.json(
      { error: 'Failed to generate token' },
      { status: 500 }
    )
  }
}

// DELETE: Revoke every previously issued widget token for the authenticated
// user by bumping token_version. Tokens embed the version they were signed
// with, and the widget endpoint rejects any token whose version isn't
// current — so the bump invalidates all outstanding tokens at once (including
// legacy version-less tokens, which count as version 1).
export async function DELETE() {
  try {
    const supabase = await createClient()
    const { data: { user }, error } = await supabase.auth.getUser()

    if (error || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const version = await currentTokenVersion(supabase, user.id)
    const next = version + 1
    const { error: upsertError } = await (supabase.from('user_widget_settings') as any)
      .upsert({ user_id: user.id, token_version: next }, { onConflict: 'user_id' })
    if (upsertError) throw upsertError

    return NextResponse.json({ revoked: true, tokenVersion: next })
  } catch (error: any) {
    console.error('Error revoking widget tokens:', error)
    return NextResponse.json(
      { error: 'Failed to revoke widget tokens' },
      { status: 500 }
    )
  }
}
