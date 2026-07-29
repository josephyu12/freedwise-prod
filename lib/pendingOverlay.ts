// Project still-queued offline actions onto freshly-read server rows.
//
// /review used to DRAIN the offline queue before it read the server, because a
// read taken mid-queue returns rows that predate every queued write: ratings you
// already gave come back blank, a highlight you archived reappears — and the
// page then re-cached that rollback. Correct, but it meant that reconnecting
// with a full queue parked you on "Loading…" behind the sync banner until the
// last action landed. That's worst on "Review ahead", which is usually tapped
// straight after a long offline session, when the queue is deepest.
//
// So the page reads immediately and replays the queue's INTENT over the result
// in memory instead of waiting. Every projection here is a plain "set this
// field to this value" or "drop this row", which makes the overlay idempotent:
// an action that drains between the snapshot and the read applies to state it
// already produced, so nothing double-counts and the snapshot can safely be a
// superset of what's still queued. The real drain then runs in the background
// and the post-sync reload replaces all of this with server truth.

export interface PendingCategory {
  id: string
  name: string
}

export interface PendingOverlayRow {
  id: string // daily_summary_highlights row id
  highlight_id: string
  rating: 'low' | 'med' | 'high' | null
  highlight: {
    id: string
    text: string
    html_content?: string | null
    source?: string | null
    author?: string | null
    categories?: PendingCategory[]
  } | null
}

export interface PendingAction {
  type: string
  params?: any
}

type HighlightPatch = Partial<NonNullable<PendingOverlayRow['highlight']>>

/**
 * Fold the queued actions down to three lookups: the rating each summary row
 * should show, which highlights are gone, and what content patch each surviving
 * highlight needs. Actions arrive oldest-first, so plain overwriting gives
 * last-write-wins — the same order the drain itself would apply them in.
 */
function foldActions(actions: PendingAction[], categories: PendingCategory[]) {
  const catById = new Map(categories.map((c) => [c.id, c]))
  const ratingByRowId = new Map<string, PendingOverlayRow['rating']>()
  const removedHighlightIds = new Set<string>()
  const patchByHighlightId = new Map<string, HighlightPatch>()

  const mergePatch = (highlightId: string, patch: HighlightPatch) => {
    patchByHighlightId.set(highlightId, { ...patchByHighlightId.get(highlightId), ...patch })
  }

  for (const action of actions) {
    const p = action.params || {}
    switch (action.type) {
      // Both rating paths write the same daily_summary_highlights row, so a
      // rating given on /daily while offline shows up here too. `rating` is
      // null when the user CLEARED it — that's a value, not a missing field.
      case 'rate-review':
      case 'rate-daily':
        if (p.summaryHighlightId) ratingByRowId.set(p.summaryHighlightId, p.rating ?? null)
        break

      case 'archive-highlight':
      case 'delete-highlight':
        if (p.highlightId) removedHighlightIds.add(p.highlightId)
        break

      // An unarchive can't be projected: the read filters on `archived = false`,
      // so the row simply isn't in hand to bring back. All we can do is cancel a
      // queued archive of the same highlight; the post-drain reload does the rest.
      case 'unarchive-highlight':
        if (p.highlightId) removedHighlightIds.delete(p.highlightId)
        break

      case 'edit-highlight': {
        if (!p.highlightId) break
        const patch: HighlightPatch = {}
        if ('text' in p) patch.text = p.text
        if ('htmlContent' in p) patch.html_content = p.htmlContent
        if ('source' in p) patch.source = p.source
        if ('author' in p) patch.author = p.author
        // The queued action carries category IDs; the row renders category
        // objects. Unknown ids (a category created offline) are dropped rather
        // than rendered as blanks — the reload picks them up.
        if (Array.isArray(p.categoryIds)) {
          patch.categories = (p.categoryIds as string[])
            .map((id) => catById.get(id))
            .filter((c): c is PendingCategory => !!c)
        }
        mergePatch(p.highlightId, patch)
        break
      }

      // Only the ORIGINAL highlight is visible in this list — the split's new
      // highlights get their own assignments server-side when the action replays.
      case 'split-highlight':
        if (p.originalHighlightId && p.firstGroup) {
          mergePatch(p.originalHighlightId, {
            text: p.firstGroup.text,
            html_content: p.firstGroup.html,
          })
        }
        break
    }
  }

  return { ratingByRowId, removedHighlightIds, patchByHighlightId }
}

/**
 * Return `rows` with every queued action applied. Rows are only replaced where
 * something actually changed, so untouched rows keep their identity.
 */
export function applyPendingActions<T extends PendingOverlayRow>(
  rows: T[],
  actions: PendingAction[],
  categories: PendingCategory[] = []
): T[] {
  if (!actions || actions.length === 0) return rows
  const { ratingByRowId, removedHighlightIds, patchByHighlightId } = foldActions(
    actions,
    categories
  )

  const out: T[] = []
  for (const row of rows) {
    if (removedHighlightIds.has(row.highlight_id)) continue

    let next = row
    if (ratingByRowId.has(row.id)) {
      next = { ...next, rating: ratingByRowId.get(row.id)! }
    }
    const patch = patchByHighlightId.get(row.highlight_id)
    if (patch && next.highlight) {
      next = { ...next, highlight: { ...next.highlight, ...patch } }
    }
    out.push(next)
  }
  return out
}

/** The same projection for the pin set, which is read alongside the rows. */
export function applyPendingPins(pinnedIds: string[], actions: PendingAction[]): string[] {
  if (!actions || actions.length === 0) return pinnedIds
  const pins = new Set(pinnedIds)
  for (const action of actions) {
    const highlightId = action.params?.highlightId
    if (!highlightId) continue
    if (action.type === 'pin-highlight') pins.add(highlightId)
    else if (action.type === 'unpin-highlight') pins.delete(highlightId)
    // A highlight deleted offline can't stay pinned.
    else if (action.type === 'delete-highlight') pins.delete(highlightId)
  }
  return Array.from(pins)
}
