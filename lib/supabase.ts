import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
// Supports both new publishable keys (sb_publishable_...) and legacy anon keys (JWT-based)
// See: https://supabase.com/docs/guides/api/api-keys
const supabaseAnonKey = 
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 
  ''

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

