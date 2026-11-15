# Review and offline contracts

Source review: 2026-11-02, starting at `753d4ce`. See [the codebase map](CODEBASE.md)
for routes and setup, and [observations](OBSERVATIONS.md) for follow-up work.

## Scheduling

- `lib/cycle.ts` defines calendar-aligned cycles of 1–12 months. The UI offers
  1, 2, 3, 4, 6, and 12. `month_year` is the cycle's start month, not necessarily
  the calendar month in which the review occurred. Use the assignment date
  when deriving a rating's ledger key, including catch-up and review-ahead.
- Missing review settings default to monthly/enabled. Missing-table errors
  are tolerated; other database errors propagate from mutation helpers.
- `lib/binPack.ts` distributes highlights by descending score (text length)
  with seeded tie-breaking. Preserved ratings contribute initial day loads.
  `lib/retile.ts` computes deterministic remaining-work layouts.
- `/api/daily/assign` rebuilds a cycle's **unrated** rows through the atomic
  `assign_cycle_layout` RPC. Rated rows and their summaries stay in place.
- `/api/daily/redistribute` is additive placement for new/orphaned IDs. It is
  not a general rebalance after deletions. It can extend placement into up to
  three already-built future cycles. `callRedistribute` is best effort.
- Applying frequency preserves rated anchors, clears unrated assignments,
  rebuilds applicable ledger keys, and saves the frequency/layout through
  `retile_schedule`. It does not globally reinterpret every historical key.
- Turning daily review off preserves the schedule. Turning it back on removes
  wholly unrated days before the current cycle; partly rated days survive.
- Explicit cycle reset is the exception: its RPC removes rated and unrated
  rows plus the cycle ledger. The caller separately requests a fresh assignment.
- The daily cron uses a service-role client and prepares the next cycle within
  seven days of the current end. Unlike the invoker scheduling RPCs, its batched
  writes and compensating cleanup are not one transaction. A lazy daily-page
  fallback also exists, but an already-existing selected summary returns early.

## Ratings and history

- `lib/applyRating.ts` owns conditional first-tap writes. Keep the returning
  projection `id, rating, rated_at`: tests cover a PostgREST return-shape issue.
  Earlier timestamps win conflicts; an explicit re-rate/clear can overwrite.
- Same-device queued ratings compact to the last action for a summary row.
  The cross-device timestamp policy is a separate mechanism.
- Online rating, ledger, and statistics writes are not one transaction. Shared
  helpers check Supabase `{ error }` responses so replay can retry partial work.
  `withDeadline` bounds the wait but does not cancel the underlying operation.
- `lib/highlightStats.ts` recomputes low=1, med=2, high=3 averages and counts.
  Low in the assignment's cycle and either adjacent cycle triggers archive,
  regardless of review order. Only lows whose assignment dates are strictly
  after the date portion of `unarchived_at` count. Clearing does not unarchive.
- Archive removes only unrated assignments from today onward. Rated archived
  appearances remain visible on their historical days. Review queues and the
  widget exclude archived highlights entirely. `lib/monthReviewStatus.ts`
  centralizes the calendar's visibility rule.
- `lib/reviewedLedger.ts` removes a cycle key on clear only if no other rated
  appearance remains in that cycle. Statistics and ledger repair paths deserve
  particular care around failed reads and the server's pagination limits.

## Review ordering

- User preference confirmed 2026-11-02: plain `/review` stays in today's normal
  queue (with existing catch-up behavior), not automatic Review Ahead. Remember
  the position within that queue. Ahead remains an explicit `?ahead=1` choice.
- Normal review includes today's assignments (rated and unrated) and older
  unrated catch-up. Today is shortest first; catch-up is oldest day first,
  then shortest. Archived highlights are excluded.
- Ahead ordering round-robins shortest highlights from each future date, then
  the next shortest from each date. `lib/aheadOrder.ts` freezes highlight IDs
  per user/cycle, with a server row and a localStorage mirror. Survivors retain
  order, removed IDs drop out, new IDs append; substantially stale lists rebuild.
- Never replace the server freeze after a failed server read. Legacy local
  row-ID sequences are translated to highlight IDs.
- `lib/preloadAhead.ts` preloads future deltas with a same-day cache marker and
  module-level single-flight. Online shortcuts require fresh snapshots; offline
  viewing may use older cached data with an offline indicator.
- `lib/reviewResume.ts` shares ordering and forward resume with the widget.
  Latest `rated_at` anchors the next unrated card; wrap to earlier skipped cards
  only after reaching the end. A per-user/day/mode local bookmark also preserves
  Next/dot navigation on that device. Newer server ratings beat older bookmarks.
  There is no new database table: cross-device/widget resume derives from saved
  rating timestamps. Next-only navigation is local, and offline changes become
  visible to the widget after syncing.
- `lib/reviewQueue.ts` serves both next-highlight APIs. It paginates today's
  rows and reads older cycle rows only for catch-up after today is complete.
  Archived rated rows can anchor resumption but are excluded from cards/counts.
  The widget route explicitly uses `fetchCache = 'force-no-store'`: in Next 14,
  `dynamic = 'force-dynamic'` and HTTP no-store headers alone still permit cached
  service-role database reads. A regression using Next's production route runtime
  reproduces stale 1/28 progress after nine ratings, and verifies fresh counts,
  next-card selection, review settings, and token revocation after this fix.
- A stale widget link to an already-rated card no longer moves the browser
  backward. Foreground/bfcache return reloads server truth unless an edit/rating
  is in progress; the local date is refreshed too. Plain-review cache reads
  strip future rows even if an ahead session last wrote the normal cache.
- History context: `be1767e` (2026-09-27) changed post-rating navigation to
  forward/wrap but explicitly kept refresh at first unrated. Reload/widget
  behavior therefore diverged. Tests reproduce skip A → rate B → reload at C.

## Offline storage and replay

- `lib/offlineStore.ts`: IndexedDB `freedwise-offline`, version 1, with
  `highlightCache` and `offlineQueue`. Cache keys include `daily-YYYY-MM-DD`,
  `review`, and `review-ahead`.
- Nine action types: review/day rating, edit, split, archive, unarchive, delete,
  pin, unpin. Adding arbitrary new highlights, merging, category edits, and
  link edits do not have a general offline action queue.
- Enqueue uses a remembered owner ID immediately; it must not wait for an auth
  refresh. Replay skips another user's stamped actions. Legacy unstamped
  actions are treated as belonging to the current user.
- Page cache keys are not user-namespaced. Explicit `AuthButton` logout handles
  pending-change confirmation and clears caches/queue/ahead mirrors. A bare
  auth sign-out event only clears the remembered owner.
- `lib/offlineReplay.ts` has one in-flight promise per JS realm, not a cross-tab
  mutex. New work during a drain triggers another pass. Root `OfflineSync`
  responds to mount, reconnect, and enqueue, with bounded automatic retries.
- Loads suspend the drain, snapshot pending actions, overlay them on the server
  result, cache the result, then resume. Suspension is nested and has a watchdog.
  Do not wait on a long drain before rendering cached/server data.
- Unknown/network errors remain queued. Permanent server rejections accrue
  attempts; after five failures, a persisted discarded-change notice is written
  before removal so subsequent valid actions can proceed.
- Split replay uses fixed child IDs and idempotent category writes to recover
  partially completed splits. Overlay can update existing rows, but cannot
  materialize every new split child missing from the cached list.
- `fetchWithTimeout` bounds requests and honors manual offline. `useOfflineStatus`
  adds health checks; the drain itself checks navigator/manual state. These are
  related but different notions of connectivity.
- `public/sw.js` caches visited same-origin page shells and immutable Next
  assets. It excludes APIs/RSC/non-GET requests. Query strings are ignored for
  page cache keys. Offline data behavior comes mainly from review/daily code,
  not from the service worker alone. Browser eviction remains possible.

## Verification map

The `__tests__` suite covers cycle math/roundtrips, packing, retile, rating
conflicts, old-cycle ledger keys, archive order/history, ahead ordering, pending
overlays, drain suspension/single-flight/retries, manual offline/abort behavior,
middleware, widget counts, and selected editor/merge interactions. These are
unit/component tests with mocked services; they do not establish deployed SQL,
browser printing, live Notion behavior, or cross-tab correctness.
