// Server-side widget-token signing + verification.
//
// Token format v2: `userId.version.expiry.signature` (HMAC-SHA256 over the
// first three parts). `version` is the user's token_version from
// user_widget_settings at signing time; the widget endpoint rejects any token
// whose version isn't current, so bumping the version (DELETE
// /api/widget-token) instantly revokes every previously issued token — the
// revocation story stateless HMAC tokens otherwise lack. Legacy v1 tokens
// (`userId.expiry.signature`, no version) verify as version 1, so widgets set
// up before this change keep working untouched until the user's first revoke.
//
// The signing key prefers WIDGET_TOKEN_SECRET so widget-token security is not
// coupled to the service-role key (rotating one must not affect the other). It
// falls back to SUPABASE_SERVICE_ROLE_KEY so nothing breaks before the env var
// exists; note that setting the env var later invalidates all outstanding
// tokens once (each device re-fetches from /widget-auth).

import crypto from 'crypto'

export const WIDGET_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

const secret = () => process.env.WIDGET_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY!

const sign = (payload: string) =>
  crypto.createHmac('sha256', secret()).update(payload).digest('hex')

const timingSafeHexEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export function createWidgetToken(userId: string, tokenVersion: number): string {
  const expiry = Date.now() + WIDGET_TOKEN_TTL_MS
  const payload = `${userId}.${tokenVersion}.${expiry}`
  return `${payload}.${sign(payload)}`
}

export interface VerifiedWidgetToken {
  userId: string
  tokenVersion: number
}

/**
 * Verify signature + expiry and return the token's claims, or null.
 * The caller MUST still compare tokenVersion against the user's current
 * version — that revocation check needs a DB read, which doesn't belong in
 * this pure helper.
 */
export function verifyWidgetToken(token: string): VerifiedWidgetToken | null {
  const parts = token.split('.')

  let userId: string
  let versionStr: string
  let expiryStr: string
  let signature: string
  if (parts.length === 4) {
    ;[userId, versionStr, expiryStr, signature] = parts
  } else if (parts.length === 3) {
    // Legacy version-less token — counts as version 1.
    ;[userId, expiryStr, signature] = parts
    versionStr = '1'
  } else {
    return null
  }

  const expiry = parseInt(expiryStr, 10)
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null
  const tokenVersion = parseInt(versionStr, 10)
  if (!Number.isFinite(tokenVersion) || tokenVersion < 1) return null

  const payload =
    parts.length === 4 ? `${userId}.${versionStr}.${expiryStr}` : `${userId}.${expiryStr}`
  if (!timingSafeHexEqual(signature, sign(payload))) return null

  return { userId, tokenVersion }
}
