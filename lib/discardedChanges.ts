/**
 * Persistent record of offline changes that were permanently DISCARDED — a
 * queued write the server kept rejecting until the replay loop dropped it (see
 * lib/offlineReplay.ts, MAX_ATTEMPTS). Dropping unblocks the rest of the queue,
 * but the user's edit/rating is gone, so we must tell them.
 *
 * Stored in localStorage (not the IndexedDB queue, which is for pending work)
 * so the notice survives the post-drop data reload AND a full page refresh —
 * it stays until the user explicitly dismisses it. A small window event lets a
 * globally-mounted banner react live without polling.
 */

const STORAGE_KEY = 'freedwise:discarded-changes'
export const DISCARDED_CHANGES_EVENT = 'freedwise:discarded-changes-updated'

export interface DiscardedChange {
  id: number // the original offline-queue action id (stable, dedupes double-records)
  type: string // OfflineActionType
  label: string // human-readable description, e.g. `Edit to "The unexamined life…"`
  at: number // when it was discarded (ms epoch)
}

function read(): DiscardedChange[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function write(list: DiscardedChange[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* quota / disabled storage — best effort */
  }
  window.dispatchEvent(new Event(DISCARDED_CHANGES_EVENT))
}

/** All discarded-change notices currently awaiting the user's acknowledgement. */
export function getDiscardedChanges(): DiscardedChange[] {
  return read()
}

/**
 * Record a permanently-dropped change. Idempotent on the action id, so a replay
 * that somehow re-reports the same dropped action won't duplicate the notice.
 */
export function recordDiscardedChange(entry: DiscardedChange): void {
  const list = read()
  if (list.some((e) => e.id === entry.id)) return
  write([...list, entry])
}

/** Clear one notice (the user dismissed a single row). */
export function dismissDiscardedChange(id: number): void {
  write(read().filter((e) => e.id !== id))
}

/** Clear every notice (the user dismissed the whole banner). */
export function clearDiscardedChanges(): void {
  write([])
}

/**
 * Build a short, human-readable label for a dropped action so the banner can say
 * WHAT was lost, not just that something was. Text snippets are stripped of HTML
 * and truncated.
 */
export function describeDiscardedAction(action: { type: string; params?: any }): string {
  const snippet = (raw: unknown): string => {
    const text = typeof raw === 'string' ? raw.replace(/<[^>]*>/g, '').trim() : ''
    if (!text) return 'a highlight'
    const max = 40
    return `"${text.length > max ? `${text.slice(0, max)}…` : text}"`
  }

  const p = action.params || {}
  switch (action.type) {
    case 'edit-highlight':
      return `Edit to ${snippet(p.text)}`
    case 'split-highlight':
      return `Split of ${snippet(p.firstGroup?.text)}`
    case 'rate-review':
    case 'rate-daily':
      return p.rating ? `Rating (${p.rating})` : 'A rating'
    case 'archive-highlight':
      return 'Archiving a highlight'
    case 'unarchive-highlight':
      return 'Unarchiving a highlight'
    case 'delete-highlight':
      return 'Deleting a highlight'
    case 'pin-highlight':
      return 'Pinning a highlight'
    case 'unpin-highlight':
      return 'Unpinning a highlight'
    default:
      return 'A change'
  }
}
