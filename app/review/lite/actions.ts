'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { rateHighlightServer } from '@/lib/rateHighlightServer'

// Rate a single highlight from the text-only lite page. Invoked as a plain
// <form> action — the clicked Low/Med/High button supplies `rating` via its
// name/value, so the whole loop works with zero client JS (progressive
// enhancement), which is the entire point of the weak-signal mode.
export async function rateAction(formData: FormData) {
  const summaryHighlightId = String(formData.get('summaryHighlightId') || '')
  const highlightId = String(formData.get('highlightId') || '')
  const rating = String(formData.get('rating') || '')
  const summaryDate = String(formData.get('summaryDate') || '')

  if (
    !summaryHighlightId ||
    !highlightId ||
    !summaryDate ||
    (rating !== 'low' && rating !== 'med' && rating !== 'high')
  ) {
    return
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return

  await rateHighlightServer(supabase, {
    summaryHighlightId,
    highlightId,
    rating,
    summaryDate,
  })

  // Re-render the list so the just-rated highlight drops out (it's now rated,
  // and the page only renders unrated ones). The request URL — including any
  // ?ahead=1 — is preserved across the action, so the mode sticks.
  revalidatePath('/review/lite')
}
