// Shared forward-resume rule for /review and the mobile widget. Keep the
// September 2026 "skip now, return at the end" behavior across reloads too.
export interface ResumeRow {
  id: string
  highlight_id: string
  date: string
  rating: unknown
  rated_at?: string | null
  highlight: { text?: string | null; archived?: boolean | null } | null
}

export interface ReviewBookmark {
  id: string
  highlightId: string
  date: string
  savedAt: number
}

export function nextUnratedAfter(rows: { rating: unknown }[], fromIndex: number): number {
  for (let step = 1; step <= rows.length; step++) {
    const i = ((fromIndex + step) % rows.length + rows.length) % rows.length
    if (rows[i].rating === null) return i
  }
  return -1
}

// Today's cards first, then catch-up by day; equal lengths use row IDs so the
// page and widget agree even if the database returned rows in a different order.
export function compareReviewRows(a: ResumeRow, b: ResumeRow, today: string): number {
  if (a.date !== b.date) {
    if (a.date === today) return -1
    if (b.date === today) return 1
    return a.date.localeCompare(b.date)
  }
  return (a.highlight?.text?.length || 0) - (b.highlight?.text?.length || 0) || a.id.localeCompare(b.id)
}

export function normalReviewRows<T extends ResumeRow>(rows: T[], today: string): T[] {
  return rows.filter((r) => r.highlight && !r.highlight.archived &&
    (r.date === today || (r.date < today && r.rating === null)))
    .sort((a, b) => compareReviewRows(a, b, today))
}

export function reviewResumeIndex<T extends ResumeRow>(
  rows: T[], today: string, bookmark: ReviewBookmark | null = null, history: T[] = rows
): number {
  const first = rows.findIndex((r) => r.rating === null)
  if (first < 0) return -1

  // A new day's queue must not resume after yesterday's catch-up position.
  const hasTodayWork = rows.some((r) => r.date === today && r.rating === null)
  let latest: T | undefined
  let latestTime = 0
  for (const r of history) {
    if (r.rating === null || (hasTodayWork && r.date < today)) continue
    const time = Date.parse(r.rated_at || '')
    if (Number.isFinite(time) && time > latestTime) { latest = r; latestTime = time }
  }

  // Local navigation (Next/dots) can be newer than the last rating. A newer
  // server rating wins over an old device's bookmark. Keying by highlight ID
  // as a fallback survives retiling, which changes unrated assignment IDs.
  if (bookmark?.date === today && bookmark.savedAt >= latestTime) {
    let i = rows.findIndex((r) => r.id === bookmark.id)
    if (i < 0) i = rows.findIndex((r) => r.highlight_id === bookmark.highlightId)
    if (i >= 0) return rows[i].rating === null ? i : nextUnratedAfter(rows, i)
  }

  if (latest) {
    const i = rows.findIndex((r) => r.id === latest!.id)
    if (i >= 0) return nextUnratedAfter(rows, i)
    // A just-rated catch-up row (or auto-archived card) may no longer be in the
    // visible queue. Resume after its sort position, then wrap when needed.
    const next = rows.findIndex((r) => r.rating === null && compareReviewRows(r, latest!, today) > 0)
    if (next >= 0) return next
  }
  return first
}

const PREFIX = 'freedwise:review-position:'
const key = (userId: string, ahead: boolean) => `${PREFIX}${userId}:${ahead ? 'ahead' : 'today'}`

export function readReviewBookmark(userId: string | undefined, today: string, ahead: boolean): ReviewBookmark | null {
  if (!userId || typeof window === 'undefined') return null
  try {
    const value = JSON.parse(localStorage.getItem(key(userId, ahead)) || 'null')
    return value?.date === today && typeof value.id === 'string' && typeof value.highlightId === 'string'
      && Number.isFinite(value.savedAt) ? value : null
  } catch { return null }
}

export function writeReviewBookmark(userId: string | undefined, ahead: boolean, bookmark: ReviewBookmark): void {
  if (!userId || typeof window === 'undefined') return
  try { localStorage.setItem(key(userId, ahead), JSON.stringify(bookmark)) } catch { /* optional local mirror */ }
}

export function clearReviewBookmarks(): void {
  if (typeof window === 'undefined') return
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k)
    }
  } catch { /* storage unavailable */ }
}
