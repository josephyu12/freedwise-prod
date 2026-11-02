# Source observations and follow-up

Reviewed 2026-11-02 from `753d4ce`. These are source observations, not a production
audit. Database migrations and external integrations were not executed.

## Fixes in this working tree

- Semantic search's “Include archived” option was applied only after ranking,
  while both SQL ranking functions excluded archived rows. Search history also
  derived calendar-month keys instead of configured cycle keys, and displayed
  only one direction of undirected highlight links. The API now uses cycle keys,
  normalizes both link directions, and requests archive-aware ranking. The new
  SQL function is in `migration_search_include_archived.sql`; until applied,
  archived semantic searches use a disclosed keyword fallback.
- Cycle assignment built its score map after removing ledger-reviewed IDs, so
  their preserved ratings contributed zero load during balancing. The score
  map now includes reviewed IDs, and the assignment join also includes scores
  for archived rated history.
- Offline pin/unpin replay removed actions after every HTTP rejection, including
  temporary authentication/server failures, without a discarded-change notice.
  These failures and login redirects now retain the action. Permanent HTTP
  rejections use the existing five-attempt/notice policy. Repeated pin requests
  are idempotent successes instead of duplicate-pin errors.
- New filtered printing shares filtering/sorting between library and export,
  loads every page before generating the preview, and rejects partial fetches.
  Filter reloads are debounced and stale responses cannot replace newer results.
- `migration_review_stats_consistency.sql` adds missing ledger-delete handling,
  recalculates average/count after rated assignments are deleted, and backfills
  stale totals. It preserves review data and archive flags.
- Review/widget resumption now uses the same forward rule as post-rating
  navigation. Git history identifies `be1767e` as introducing that mismatch
  (forward after rating, first-unrated on refresh). `reviewResume.ts` uses
  existing `rated_at` values and a user/day/mode local bookmark; no new SQL is
  required for this fix. Plain Review remains in today's queue. Stale rated
  widget links and cached ahead rows no longer redirect it to the wrong card.

**Deployment:** both new SQL migrations remain unapplied and were not executed
against a database. Source fixes and migrations are separate deliverables. See
[the migration guide](../supabase/MIGRATIONS.md) for prerequisites.

**Verification:** unit/component regressions, TypeScript, lint, and production
build passed. Chrome printed a synthetic 24-highlight fixture to a 13-page PDF;
all entries, Unicode, and the end of a multi-page passage were present, with
print controls hidden. No production highlights or Notion data were used.

## Remaining limitations / decisions

- Notion sync is intentionally manual: commit `71b04c9` explicitly removed
  automatic sync. `NotionSyncProcessor` remains unmounted; that alone is not a
  bug. Current entry points are the buttons on highlights/settings.
- Some reads remain unpaginated, including statistics/history and integration
  status paths. Supabase's default row limit can produce incomplete aggregates.
- The cron's batched next-cycle build can be left partially populated after
  interruption; its “any summaries exist” check may then skip repair.
- Frequency application can build current-cycle buckets even while daily review
  is disabled; its exact intended behavior needs to be kept consistent with the
  preserve-schedule toggle policy.
- Cache keys/discarded notices are not user-namespaced. Explicit logout purges
  most local state, but other session transitions do not perform the same purge.
- `types/database.ts` is incomplete (e.g. generated scores/embeddings and several
  RPCs), and extensive `any` casts limit compile-time verification.
- Notion updates/deletes match block content heuristically. Database writes and
  remote edits are not one transaction, and the request gate is process-local.
- `sanitizeHtml` is a formatting cleaner. Rendering uses DOMPurify through
  `sanitizeForRender`; inspect editor/paste boundaries independently for work
  that changes trusted/untrusted HTML handling.
- Old design plans are historical. In particular, use current source/tests for
  review-off preservation and rated-row invariants.

## Setup documentation drift

`supabase/schema.sql` intentionally raises an error. `migration_complete.sql`
is a base aggregate, not the full current schema. Later migrations include
updated timestamps, edit logs/retention, embeddings, hybrid search, merge
suggestions, and Notion queue coalescing. Timestamp migration precedes edit logs;
embeddings precede hybrid search/merge suggestions. Re-running the aggregate can
restore an older Notion trigger body. Review the actual SQL/deployed state;
some historical migrations deduplicate, delete, or backfill data.

See [the codebase map](CODEBASE.md) and [migration guide](../supabase/MIGRATIONS.md).
