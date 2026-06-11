'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { rateHighlightServer } from '@/lib/rateHighlightServer'

interface RateParams {
  summaryHighlightId: string
  highlightId: string
  rating: string
  summaryDate: string
}

// Shared persistence core for both the no-JS form action and the hydrated
// island. Returns false (rather than throwing) for bad input / no auth so the
// form path can ignore it quietly; throws only on a real DB/network failure so
// the island can fall back to the offline queue and keep the action for retry.
async function persistRating(p: RateParams): Promise<boolean> {
  if (
    !p.summaryHighlightId ||
    !p.highlightId ||
    !p.summaryDate ||
    (p.rating !== 'low' && p.rating !== 'med' && p.rating !== 'high')
  ) {
    return false
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return false

  await rateHighlightServer(supabase, {
    summaryHighlightId: p.summaryHighlightId,
    highlightId: p.highlightId,
    rating: p.rating,
    summaryDate: p.summaryDate,
  })
  return true
}

// No-JS fallback path. Invoked as a plain <form> action — the clicked
// Low/Med/High button supplies `rating` via its name/value. After persisting we
// revalidate so the server-rendered list repaints with the new rating filled
// in; this is the only way to reflect the change when the island hasn't
// hydrated (the entire point of the weak-signal mode). When JS is present, the
// RateButtons island intercepts the submit and calls rateOne instead.
export async function rateAction(formData: FormData) {
  const ok = await persistRating({
    summaryHighlightId: String(formData.get('summaryHighlightId') || ''),
    highlightId: String(formData.get('highlightId') || ''),
    rating: String(formData.get('rating') || ''),
    summaryDate: String(formData.get('summaryDate') || ''),
  })
  // Re-render the list so the just-rated highlight shows its rating filled in.
  // Every row stays put (rated rows aren't filtered out), so nothing disappears.
  // The request URL — including any ?ahead=1 — is preserved across the action.
  if (ok) revalidatePath('/review/lite')
}

// Hydrated-island path: online taps and offline-queue replay. Persists WITHOUT
// revalidating — the client owns the UI optimistically, so a full server
// refetch per tap would just waste bandwidth on the weak-signal page. Throws on
// failure so the caller can queue/keep the action for retry.
export async function rateOne(p: RateParams): Promise<boolean> {
  const ok = await persistRating(p)
  if (!ok) throw new Error('rate failed: unauthenticated or invalid input')
  return true
}
