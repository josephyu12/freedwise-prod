# Repository working notes

@/Users/joseph/.codex/RTK.md

Prefix shell commands with `rtk`; use `rtk proxy <command>` when raw output or an
unsupported command is needed.

## Start here

- [Codebase map](docs/CODEBASE.md): architecture, routes, data model, integrations,
  configuration, and verification commands.
- [Review and offline behavior](docs/REVIEW_AND_OFFLINE.md): scheduling, ratings,
  archive history, ordering, caches, and replay invariants.
- [Observed gaps](docs/OBSERVATIONS.md): source-confirmed documentation drift and
  areas to investigate before changing related behavior.

These notes began at `753d4ce` on 2026-11-02 and include this working tree's fixes
and filtered PDF export. Recheck the
relevant implementation when working on a feature; notes are a navigation aid,
not a replacement for source or evidence about the deployed database.

## Important conventions

- This is Next.js App Router with extensive browser-to-Supabase access. RLS and
  SQL triggers/RPCs are application logic, not incidental deployment details.
- `highlight_months_reviewed.month_year` means **cycle start key**, not necessarily
  calendar month. Use `lib/cycle.ts`; derive rating keys from the assignment date.
- Preserve rated assignment rows during scheduling and archival. Explicit cycle
  reset removes assignments and their ledger together; deleting/merging a highlight
  also intentionally cascades its history.
- Keep `/review`, `/daily`, and offline replay behavior aligned. Prefer the shared
  rating, stats, ledger, visibility, and pending-overlay helpers.
- Supabase often resolves with `{ error }`; `.catch()` alone does not establish
  that a database operation succeeded.
- `addToNotionSyncQueue` only emits a browser event. Database triggers enqueue
  Notion work. Do not add a second client enqueue path.
- `sanitizeHtml` cleans formatting; `sanitizeForRender` uses DOMPurify for security.
- `supabase/schema.sql` intentionally throws. `migration_complete.sql` is a base
  aggregate with missing later features; see the notes before database setup.
- Library and PDF export share `lib/highlightFilters.ts`. Export fetches every
  page through `lib/highlightPrint.ts`; keep it independent of visible pagination.
- The new archive-search and review-statistics migrations are prepared but
  unapplied. See `supabase/MIGRATIONS.md` before claiming those DB fixes are live.
- Plain Review stays in today's queue; ahead is explicit. `lib/reviewResume.ts`
  shares forward-resume behavior with the widget using existing `rated_at`, plus
  a user/day/mode local navigation bookmark. See `be1767e` for the historical
  mismatch between post-rating navigation and first-unrated reloads.

## Local checks

```sh
rtk npm test
rtk proxy npx --no-install tsc --noEmit --incremental false
rtk npm run lint
```

The initial baseline passed 253 tests in 38 files. After export, fixes, and
review/widget resumption, the full suite passed 288 tests in 45 files.
TypeScript, lint, and production build passed. Run standalone TypeScript after
the Next build, not concurrently: the build replaces `.next/types` while tsc
reads them. Chrome also verified a 13-page synthetic PDF.
No production database or Notion operations were performed.
