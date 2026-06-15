'use client'

import { useEffect, useState } from 'react'
import { format } from 'date-fns'

// Per-row "Catching up · Jun 12" / "Reviewing ahead · Jun 16" label.
//
// Why this is a client island instead of plain server markup: the lite page is
// a force-dynamic server component whose "today" is baked into the HTML at
// render time, and the service worker caches that HTML and may replay it on a
// LATER day (weak signal). A server-computed label then freezes — a date that
// was genuinely "reviewing ahead" when rendered still reads that way after it's
// slipped into the past. So we seed from the server's `serverToday` (so the
// initial render matches the SSR HTML — no hydration mismatch) and, on mount,
// recompute against the device's live local date. A fresh online load is a
// no-op; a stale cached page corrects itself.
export default function RowDateLabel({
  date,
  serverToday,
}: {
  date: string
  serverToday: string
}) {
  const [today, setToday] = useState(serverToday)

  useEffect(() => {
    // Client `new Date()` is already in the device's local zone, matching the
    // wire format en-CA produced server-side.
    setToday(format(new Date(), 'yyyy-MM-dd'))
  }, [])

  // A row dated today gets no label (it's the default bucket).
  if (date === today) return null

  return (
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
      {date < today ? 'Catching up' : 'Reviewing ahead'} ·{' '}
      {format(new Date(`${date}T00:00:00`), 'MMM d')}
    </div>
  )
}
