# Configurable Review Frequency — Implementation Plan

**Status:** Design / not yet implemented
**Goal:** Let a user review their highlights on a cadence other than monthly — e.g. **every 2 months (bimonthly)** or **every 3 months (quarterly)** — instead of the hardcoded one-calendar-month cycle. And let a user **turn daily review off entirely** if they don't want any resurfacing.
**Author:** prepared as a future-implementation spec. Read this top-to-bottom before writing any code.

---

## 0. TL;DR

Today the app equates **one review cycle == one calendar month**. Every highlight resurfaces exactly once per calendar month, bin-packed across the days of that month by character count. That equivalence is hardcoded in ~17 places.

The change is to introduce a **cycle abstraction** (`frequency_months ∈ {1, 2, 3, …}`) and replace "calendar month" with "cycle" everywhere. A cycle is `N` contiguous, **calendar-aligned** months. Each highlight resurfaces once per cycle, spread across all days of the cycle (so a quarterly cycle is ~90 days and each day is ~⅓ as heavy — exactly the lighter cadence you want).

A second, **orthogonal** control lets a user disable resurfacing altogether: `daily_review_enabled ∈ {true, false}`. When `false`, no new assignments are ever generated for that user — the cron skips them, lazy assignment on `/daily` is a no-op, and the widget shows a calm "off" state. Frequency and enabled are independent: turning review off does not lose your chosen cadence, and turning it back on resumes at that cadence.

**The single most important property:** with `frequency_months = 1` and `daily_review_enabled = true` (the defaults), the cycle key, cycle date list, and bin-packing seed are all **byte-identical** to today's behavior. So the feature ships dark, monthly users are completely unaffected, and there is **zero data migration**.

---

## Table of contents

1. [Current architecture (what's coupled to "month")](#1-current-architecture)
2. [Design decisions](#2-design-decisions)
3. [The cycle model & math](#3-the-cycle-model--math)
4. [New shared module: `lib/cycle.ts`](#4-new-shared-module-libcyclets)
5. [Database migration](#5-database-migration)
6. [File-by-file change spec](#6-file-by-file-change-spec)
7. [The cron change (highest operational risk)](#7-the-cron-change)
8. [Backward-compatibility invariants](#8-backward-compatibility-invariants)
9. [Rollout phases](#9-rollout-phases)
10. [Test matrix](#10-test-matrix)
11. [Known caveats / explicitly out of scope](#11-known-caveats--out-of-scope)

---

## 1. Current architecture

### The data model
- **`highlights`** — the user's library (unarchived ones are the review pool).
- **`daily_summaries (date, user_id)`** — one row per day that has assignments.
- **`daily_summary_highlights (daily_summary_id, highlight_id, rating)`** — which highlights are assigned to a given day, and the 1–5 rating once reviewed.
- **`highlight_months_reviewed (highlight_id, month_year)`** — the **dedup ledger**. `month_year` is `"YYYY-MM"`. A row means "this highlight was already reviewed in this period," so it won't be re-assigned within the same period. Written when a rating is set.

### The lifecycle
1. **`prepare-next-month`** (Vercel cron, monthly on the 24th) bin-packs **all** unarchived highlights across the days of *next month*, balancing total character count ("score") per day. Each highlight lands on exactly one day.
2. **`assign`** does the same for a specified `{year, month}`, on demand (lazy creation + "reset").
3. **`redistribute`** handles mid-cycle additions: places newly-added highlights onto the remaining days of the current month, and into any already-portioned future months.
4. User reviews each day on `/daily`; rating a highlight writes its `daily_summary_highlights.rating` **and** upserts `highlight_months_reviewed`.
5. DB triggers (`migration_resurface_stats.sql`) keep `highlights.resurface_count = COUNT(DISTINCT month_year)` and `last_resurfaced`.

### Everything that hardcodes "calendar month"

| # | Location | Coupling |
|---|----------|----------|
| 1 | `app/api/daily/assign/route.ts` | `daysInMonth`, day-index 1..31, `monthYear` dedup, `{year,month}` input |
| 2 | `app/api/daily/prepare-next-month/route.ts` | next *calendar* month, duplicate bin-packer, per-user loop |
| 3 | `app/api/daily/redistribute/route.ts` | "remaining days in month", future-months loop (offset 1..6), `monthYear` |
| 4 | `app/api/daily/reset-month/route.ts` | current-month window + HMR delete by `monthYear` |
| 5 | `app/api/daily/cleanup/route.ts` | single `date` only — **already cycle-agnostic, no change** |
| 6 | `app/api/review/widget/route.ts` | catch-up uses `firstOfMonth = today.substring(0,8)+'01'` |
| 7 | `app/api/review/next/route.ts` | today only — **no change** |
| 8 | `app/api/stats/reviewed-count/route.ts` | defaults to previous *calendar* month, month window, HMR by `monthYear` |
| 9 | `app/api/stats/reviewed-count/repair/route.ts` | month window backfill + "spurious current-month" cleanup |
| 10 | `app/daily/page.tsx` | month-grid calendar, `ensureDailySummary` month logic, `handleRatingChange` HMR writes (2 sites), `monthReviewStatus`, `monthsWithAssignments` |
| 11 | `app/settings/page.tsx` | reset calls `reset-month` + `assign{year,month}`, "Last month reviewed" UI |
| 12 | `lib/redistribute.ts` | posts `localDate` only — **no change** |
| 13 | `lib/removeFromFutureMonths.ts` | deletes `date >= today` assignments — **cycle-agnostic, no change** |
| 14 | `lib/offlineStore.ts` | caches `monthReviewStatus`, `monthsWithAssignments` — rename optional |
| 15 | `highlight_months_reviewed` (table) | `month_year` column is the period key |
| 16 | `supabase/migration_resurface_stats.sql` | `COUNT(DISTINCT month_year)`, `to_char(date,'YYYY-MM')` |
| 17 | `vercel.json` | monthly cron `0 0 24 * *` |

The duplicated bin-packing algorithm lives in **three** routes (assign, prepare-next-month, redistribute). Consolidate it (see §6.0) or the cycle change has to be made — and kept correct — in three places.

---

## 2. Design decisions

### D1 — "Bimonthly" means *every two months* (a longer cycle) — **confirmed**
Settled: bimonthly = **every two months**, a longer cycle. So `frequency_months = 2` ⇒ a ~60-day cycle, `= 3` ⇒ a ~90-day cycle. ("Twice a month" — a sub-month split — is a different mechanism and is explicitly out of scope.)

### D2 — One cadence per user (global), not per-highlight
The whole library reviews on a single frequency. Per-highlight or per-category cadence (overlapping cycles on the same days) is a much larger project and is explicitly **out of scope** here. The schema (a per-user setting) leaves room to revisit later.

### D3 — Cycles are calendar-aligned to a fixed epoch, not anchored to signup
Quarterly = Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec for **every** user. Bimonthly = Jan–Feb, Mar–Apr, … This is deterministic, shareable, and — critically — makes `frequency_months = 1` collapse exactly onto today's calendar months. No per-user drift, no anchor column needed.

### D4 — `cycle_key` = the cycle's **start month** in `YYYY-MM`
Reuse the existing `highlight_months_reviewed.month_year` column as a generic cycle key. For `frequency_months = 1`, the start month *is* the calendar month, so **all existing rows stay valid and no backfill is needed.** For quarterly, Q1 2026's key is `2026-01`.

### D5 — "Off" is a separate boolean, not `frequency_months = 0`
Disabling daily review is modeled as `daily_review_enabled BOOLEAN NOT NULL DEFAULT TRUE`, **orthogonal** to `frequency_months`. Reasons:
- It keeps the cycle math total (`frequency_months` stays `≥ 1`, so every invariant in §8 is untouched — there is no "0-month cycle" to special-case in `lib/cycle.ts`).
- It preserves the user's chosen cadence across an off→on toggle. Turning review back on resumes at bimonthly/quarterly, not a reset to monthly.
- The "enabled?" check is a single early `return`/skip at each entry point (cron, lazy assign, redistribute, widget) — additive, not a rewrite of the distribution logic.

**Off does not delete reviewed history.** It stops generating *new* assignments and clears *future, un-rated* assignments (so the calendar doesn't show stale work). Past `daily_summaries` and all `daily_summary_highlights.rating` / `highlight_months_reviewed` rows are left intact, so stats and resurface counts are preserved and re-enabling is lossless.

---

## 3. The cycle model & math

Represent any month as an absolute index `idx = year*12 + (month-1)` (epoch = year 0, January = 0). Then:

```
startIdx = floor(idx / freq) * freq      // first month of the containing cycle
endIdx   = startIdx + freq - 1           // last month of the containing cycle
```

Because the epoch is January-aligned, `freq = 3` puts boundaries at indices divisible by 3 → January, April, July, October (calendar quarters). `freq = 2` → Jan, Mar, May, … `freq = 1` → every month (identity).

The cycle's **date list** is every `YYYY-MM-DD` from the first day of `startIdx`'s month through the last day of `endIdx`'s month, iterating month-by-month so 28/29/30/31-day months and year rollovers are handled exactly.

Worked examples:
- `freq=1`, June 2026 → cycle `2026-06`, dates `2026-06-01 … 2026-06-30`. **Identical to today.**
- `freq=2`, given any day in March or April 2026 → cycle `2026-03`, dates `2026-03-01 … 2026-04-30`.
- `freq=3`, given any day in Oct/Nov/Dec 2026 → cycle `2026-10`, dates `2026-10-01 … 2026-12-31` (spans into year boundary; next cycle is `2027-01`).

---

## 4. New shared module: `lib/cycle.ts`

This is the foundation; everything else consumes it. Reference implementation (verified against the examples above):

```ts
// lib/cycle.ts
export interface Cycle {
  freq: number
  startYear: number
  startMonth: number // 1-12
  endYear: number
  endMonth: number   // 1-12
  startDate: string  // YYYY-MM-DD, first day of the cycle
  endDate: string    // YYYY-MM-DD, last day of the cycle
  key: string        // YYYY-MM of the start month (== month_year when freq === 1)
  dates: string[]    // every YYYY-MM-DD in the cycle, ascending
}

const pad = (n: number) => String(n).padStart(2, '0')
// m is 1-12; new Date(y, m, 0) gives the last day of month m, so .getDate() == days in month
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate()
const monthIndex = (y: number, m: number) => y * 12 + (m - 1)
const fromIndex = (idx: number) => ({ year: Math.floor(idx / 12), month: (idx % 12) + 1 })

/** The cycle that contains (year, month) for a given frequency. */
export function getCycle(year: number, month: number, freq: number): Cycle {
  const f = Math.max(1, Math.floor(freq || 1))
  const startIdx = Math.floor(monthIndex(year, month) / f) * f
  const endIdx = startIdx + f - 1
  const { year: sy, month: sm } = fromIndex(startIdx)
  const { year: ey, month: em } = fromIndex(endIdx)

  const dates: string[] = []
  let cy = sy
  let cm = sm
  for (let k = 0; k < f; k++) {
    const dim = daysIn(cy, cm)
    for (let d = 1; d <= dim; d++) dates.push(`${cy}-${pad(cm)}-${pad(d)}`)
    cm++
    if (cm > 12) { cm = 1; cy++ }
  }

  return {
    freq: f,
    startYear: sy, startMonth: sm,
    endYear: ey, endMonth: em,
    startDate: `${sy}-${pad(sm)}-01`,
    endDate: `${ey}-${pad(em)}-${pad(daysIn(ey, em))}`,
    key: `${sy}-${pad(sm)}`,
    dates,
  }
}

export function getCycleForDate(dateStr: string, freq: number): Cycle {
  const [y, m] = dateStr.split('-').map(Number)
  return getCycle(y, m, freq)
}

export function cycleKey(year: number, month: number, freq: number): string {
  return getCycle(year, month, freq).key
}

/** The cycle immediately after `c`. */
export function nextCycle(c: Cycle): Cycle {
  let ny = c.endYear
  let nm = c.endMonth + 1
  if (nm > 12) { nm = 1; ny++ }
  return getCycle(ny, nm, c.freq)
}

/** Per-cycle deterministic seed. For freq===1 this equals the old `year*373 + month*31`. */
export function cycleSeed(c: Cycle): number {
  return c.startYear * 373 + c.startMonth * 31
}
```

And a tiny server helper for reading the per-user settings (defaults: monthly, enabled):

```ts
// lib/cycle.ts (continued) — or a server-only file if you prefer
export interface ReviewSettings {
  freq: number      // frequency_months, ≥ 1
  enabled: boolean  // daily_review_enabled
}

export async function getUserReviewSettings(
  supabase: any,
  userId: string
): Promise<ReviewSettings> {
  const { data } = await supabase
    .from('user_review_settings')
    .select('frequency_months, daily_review_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  const row = data as { frequency_months?: number; daily_review_enabled?: boolean } | null
  const f = row?.frequency_months
  return {
    freq: f && f >= 1 ? f : 1,
    enabled: row?.daily_review_enabled ?? true, // default ON when no row exists
  }
}

/** Convenience: frequency only (back-compat). */
export async function getUserFrequency(supabase: any, userId: string): Promise<number> {
  return (await getUserReviewSettings(supabase, userId)).freq
}
```

> **Default ON is load-bearing.** A user with no `user_review_settings` row must read as `enabled = true` (and `freq = 1`) so today's behavior is preserved with zero rows written. Never treat "missing row" as "off."

> **Why `cycleSeed` matters:** the bin-packer is seeded by `year*373 + month*31` today. Using the cycle's **start** month keeps the seed (and therefore the exact assignment) identical for `freq=1`. Don't seed off "today" or the viewed month — seed off the cycle start.

---

## 5. Database migration

New file `supabase/migration_review_frequency.sql` (idempotent, RLS-correct, follows the conventions in `supabase/MIGRATIONS.md`):

```sql
-- Migration: per-user review frequency (monthly / bimonthly / quarterly / …)
-- Adds user_review_settings. The existing highlight_months_reviewed.month_year
-- column is REINTERPRETED as a generic "cycle key" (the cycle's start month,
-- YYYY-MM). For frequency_months = 1 (the default) the cycle key IS the calendar
-- month, so all existing rows remain valid and NO data migration is required.

CREATE TABLE IF NOT EXISTS user_review_settings (
  user_id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  frequency_months    INTEGER NOT NULL DEFAULT 1
                      CHECK (frequency_months >= 1 AND frequency_months <= 12),
  daily_review_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- If the table predates this column (shipped frequency first), add it idempotently:
ALTER TABLE user_review_settings
  ADD COLUMN IF NOT EXISTS daily_review_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE user_review_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own review settings" ON user_review_settings;
CREATE POLICY "Users can view their own review settings" ON user_review_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own review settings" ON user_review_settings;
CREATE POLICY "Users can insert their own review settings" ON user_review_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own review settings" ON user_review_settings;
CREATE POLICY "Users can update their own review settings" ON user_review_settings
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own review settings" ON user_review_settings;
CREATE POLICY "Users can delete their own review settings" ON user_review_settings
  FOR DELETE USING (auth.uid() = user_id);

-- Reuse the existing updated_at trigger function if present, else create one.
CREATE OR REPLACE FUNCTION update_user_review_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_review_settings_updated_at ON user_review_settings;
CREATE TRIGGER update_user_review_settings_updated_at
  BEFORE UPDATE ON user_review_settings
  FOR EACH ROW EXECUTE FUNCTION update_user_review_settings_updated_at();
```

Then:
- Fold the same table into `supabase/migration_complete.sql` (the canonical from-scratch schema).
- Add an entry to `supabase/MIGRATIONS.md` (next number in sequence) **and** to the pending-migration note in `~/.claude/.../memory/MEMORY.md` so it actually gets run on prod before deploy (matching the existing pending-migration convention).

The service-role cron route (`prepare-next-*`) reads `user_review_settings` with the service-role client (bypasses RLS) — fine. Browser/widget paths read under RLS — the policies above cover them.

---

## 6. File-by-file change spec

### 6.0 — First, extract the shared bin-packer (`lib/binPack.ts`)
The identical `seededShuffle` + `hashStr` + "assign to lightest day" loop is copy-pasted in `assign`, `prepare-next-month`, and `redistribute`. Extract one function that takes **explicit date strings** instead of a day count:

```ts
// lib/binPack.ts
export interface Scored { id: string; text: string; html_content: string | null; score: number }
export interface DayBucket { date: string; highlights: Scored[]; totalScore: number }

export function packIntoDates(items: Scored[], dates: string[], seed: number): DayBucket[] {
  // 1. seededShuffle(items, seed)  2. sort desc by score
  // 3. for each item: place on the lowest-totalScore bucket; tie-break with (seed + hashStr(id))
  // 4. seededShuffle each bucket's highlights with (seed + indexHash) so order isn't longest-first
  // Return one bucket PER date in `dates` (buckets may be empty).
}
```

Note the key change vs today: buckets are keyed by **`date: string`**, not `day: number (1..31)`. A cycle spans months, so a 1..31 index is meaningless — every assignment must carry its real ISO date. This ripples through assign/prepare (see below).

### 6.1 — `app/api/daily/assign/route.ts`
- Input: keep accepting `{ year, month }` (a month *inside* the target cycle) to minimize caller churn. Internally: `const { freq, enabled } = await getUserReviewSettings(supabase, user.id);` — **if `!enabled`, return early with an empty result (HTTP 200, e.g. `{ assigned: 0, disabled: true }`)** rather than packing anything. Otherwise `const cycle = getCycle(year, month, freq);`
- Replace `daysInMonth` / `startDate` / `endDate` with `cycle.dates`, `cycle.startDate`, `cycle.endDate`.
- Replace `monthYear` dedup with `cycle.key`.
- Replace `assignHighlightsToDays(..., daysInMonth, year, month)` with `packIntoDates(scored, cycle.dates, cycleSeed(cycle))`.
- The "preserve completed days" / "existing summaries in window" logic now queries the **cycle window** `[cycle.startDate, cycle.endDate]` (which may span 2–3 calendar months) — the existing `.gte('date', start).lte('date', end)` form already works once start/end are the cycle bounds.
- Everywhere a date was built as `${year}-${month}-${day}`, use the bucket's `date` directly.

### 6.2 — `app/api/daily/prepare-next-month/route.ts` → `prepare-next-cycle`
- Rename concept (keep or rename the path — see §7). Per user: `{ freq, enabled } = getUserReviewSettings(...)`. **If `!enabled`, `continue` to the next user** — disabled users are never portioned. Then `current = getCycleForDate(todayLocal, freq)`, `next = nextCycle(current)`.
- **Guard:** only portion `next` when (a) today is within `LEAD_DAYS` (7) of `current.endDate`, **and** (b) `next` has zero `daily_summaries` yet (idempotency — daily cron must not re-portion). For `freq=1` this reproduces "prepare next month ~7 days before month end."
- Build assignments with `packIntoDates(scored, next.dates, cycleSeed(next))`, filtering out highlights already in `highlight_months_reviewed` for `next.key`.
- The delete-and-recreate of the target window now spans `next.startDate..next.endDate`.

### 6.3 — `app/api/daily/redistribute/route.ts` (highest-risk file)
- `const { freq, enabled } = await getUserReviewSettings(...);` — **if `!enabled`, return early (no-op)**: a disabled user's newly-added highlights must not be placed anywhere.
- `const cycle = getCycleForDate(clientLocalDate, freq);`
- "remaining days in month" → cycle dates strictly after today within `cycle` (and the `isLastDayOfMonth` special-case → `today === cycle.endDate`).
- The future-**months** loop (offset 1..6, breaking at the first month with no summaries) → a future-**cycles** loop: start at `nextCycle(cycle)`, walk forward (cap at ~3 cycles), break at the first cycle with no `daily_summaries`. Within each future cycle, dedup against `highlight_months_reviewed` for that cycle's key and pack with `cycleSeed(futureCycle)`.
- All `${year}-${month}-${d}` date construction → iterate `cycle.dates`.
- Reviewed dedup key → `cycle.key`.
- Because this file is the most intricate, lean on `lib/cycle.ts` + `lib/binPack.ts` rather than re-deriving math inline.

### 6.4 — `app/api/daily/reset-month/route.ts` → `reset-cycle`
- Window = current cycle `[cycle.startDate, cycle.endDate]`.
- HMR deletion: delete rows where `month_year = cycle.key` (a single key per cycle now) for the user's highlight ids — same chunked delete, just one key instead of one calendar month.

### 6.5 — `app/api/review/widget/route.ts`
- `const { freq, enabled } = await getUserReviewSettings(supabase, userId);` — **if `!enabled`, return an empty/off payload** (e.g. `{ enabled: false, items: [] }`) so the widget renders a calm "Daily review is off" state instead of stale assignments. The client should treat this as "nothing due," not an error.
- The catch-up branch computes `firstOfMonth = today.substring(0,8) + '01'`. Replace with the cycle start: `const start = getCycleForDate(today, freq).startDate;` then `.gte('daily_summary.date', start).lt('daily_summary.date', today)`. So "catch up on anything unreviewed earlier this **cycle**."
- `review/next` has no catch-up branch → it still needs the same `!enabled` early-out so it returns nothing for disabled users (optionally add the cycle catch-up for parity too).

### 6.6 — `app/api/stats/reviewed-count/route.ts` + `repair/route.ts`
- Default window "previous calendar month" → "previous cycle": `prevCycle = getCycle(<a month before current cycle start>, freq)`; window `[prevCycle.startDate, prevCycle.endDate]`; HMR key `prevCycle.key`.
- Accept `?cycle=YYYY-MM` (a cycle start) instead of / in addition to `?month=YYYY-MM`.
- In `repair`, the "remove spurious current-**month** HMR rows" cleanup becomes "current-**cycle**." Keep this consistent or the "Last reviewed" card miscounts. Medium priority (stats only, not the core loop).

### 6.7 — `app/daily/page.tsx`
- Load the user's `{ freq, enabled }` once on mount; thread both through.
- **When `!enabled`:** `ensureDailySummary` does nothing (no lazy assign, no prepare-next-cycle), and the page renders an "off" empty state — a short line ("Daily review is off") with a link to Settings to turn it back on — instead of the calendar/review UI. Existing rated history can still be browsable if desired, but no new work is generated.
- `ensureDailySummary`: "assignments exist for this **month**?" → "for this **cycle**?" (query `[cycle.startDate, cycle.endDate]`); the assign call passes a month inside the cycle; the "prepare next month if `daysUntilMonthEnd <= 7`" branch → "prepare next **cycle** if today within 7 days of `cycle.endDate`." (All gated behind `enabled`.)
- `handleRatingChange` — **two** HMR upsert sites (~L810 and ~L1573): today they derive `monthYear` from `summary.date`'s month. Change to `cycleKey(y, m, freq)` from `summary.date`. This is the write that makes dedup correct across a multi-month cycle — do not miss either site.
- Calendar grid: keep month-by-month navigation as a pure **date browser**; days outside the active cycle simply have no assignments. `monthReviewStatus` / `monthsWithAssignments` are per-date and keep working. Optional polish: shade the active cycle's span or show a "Cycle: Jan–Mar 2026" label.
- Copy: "this month" → "this cycle" where user-facing.

### 6.8 — `app/settings/page.tsx`
- Add a **"Daily review" on/off toggle** that persists `daily_review_enabled` to `user_review_settings`. Place it above the frequency selector and disable/grey-out the frequency selector when review is off (the cadence is meaningless while off, but the stored value is retained for when it's re-enabled).
  - **Turning OFF:** confirm ("New highlights won't resurface until you turn this back on. Your past reviews are kept."), then clear *future, un-rated* assignments so the calendar isn't left showing stale work. Reuse `lib/removeFromFutureMonths.ts` (it already deletes `date >= today` assignments) — but only delete days/highlights with no rating; rated days stay as history. Then persist `daily_review_enabled = false`.
  - **Turning ON:** persist `daily_review_enabled = true`, then lazily re-portion the current cycle via `assign` for a month inside the current cycle (same path `ensureDailySummary` uses). Resumes at the stored `frequency_months`.
- Add a **frequency selector**: Monthly (1) / Every 2 months (2) / Quarterly (3). Persists to `user_review_settings`. (Hidden/disabled while review is off.)
- **Changing frequency reshapes cycles**, so on change show a confirm and then re-portion: call `reset-cycle` + `assign` for the (new) current cycle, preserving already-rated days, and clear any future pre-portioned cycles that no longer align. Treat this as an explicit "Apply new frequency" action, not a silent toggle.
- Reset button: `reset-month` → `reset-cycle`; assign passes the current cycle. Copy "month" → "cycle."
- "Last month reviewed" card → "Last cycle reviewed"; stats fetch uses the cycle param. Update the `data.month` → label code (it currently formats a `YYYY-MM` as a single month; for a multi-month cycle, render a range using `cycle.startDate`/`endDate`).

### 6.9 — `vercel.json`
See §7.

### 6.10 — `lib/offlineStore.ts`
`monthReviewStatus` / `monthsWithAssignments` keep working as-is (keyed by date/month string). Renaming to `cycle*` is cosmetic; defer unless you're touching the file anyway.

---

## 7. The cron change

**This is the biggest operational shift and the easiest thing to get subtly wrong.**

Today: `vercel.json` runs `prepare-next-month` once a month (`0 0 24 * *`). That only works because every user's period boundary is the same calendar date. With per-user frequencies, **cycle boundaries differ between users** (a quarterly user's next cycle starts in a different month than a bimonthly user's).

**Fix:** make the cron **daily** and push the "is it time?" decision *inside* the route, per user:

```jsonc
// vercel.json
{ "crons": [ { "path": "/api/daily/prepare-next-cycle", "schedule": "0 0 * * *" } ] }
```

Inside the route, for each user:
1. `{ freq, enabled } = getUserReviewSettings(...)`. **If `!enabled`, skip this user entirely** — no portioning while review is off.
2. `current = getCycleForDate(today, freq)`, `next = nextCycle(current)`
3. If `today` is within `LEAD_DAYS` (7) of `current.endDate` **and** `next` has no summaries → portion `next`. Else skip.

Idempotency (the "next has no summaries" guard) is mandatory now that the job runs every day — without it, a daily run would re-portion (and the existing delete-and-recreate would wipe) the upcoming cycle repeatedly.

For `freq=1` this is behaviorally equivalent to the old monthly job (prepares next month in the last week), just triggered by a daily heartbeat instead of a fixed date — strictly more robust.

> If you prefer not to rename the path, keep `/api/daily/prepare-next-month` and only change the schedule + internals. The `/daily` page's own lazy "prepare next month within 7 days" path (in `ensureDailySummary`) is the belt-and-suspenders fallback and should get the same cycle treatment regardless.

---

## 8. Backward-compatibility invariants

These **must** hold so `frequency_months = 1` is a no-op for existing users:

1. **`getCycle(y, m, 1).key === "YYYY-MM"`** of that month → existing `highlight_months_reviewed` rows stay valid, zero backfill.
2. **`getCycle(y, m, 1).dates`** === exactly the days `01..lastDay` of that month, ascending → identical assignment slots.
3. **`cycleSeed(getCycle(y, m, 1))` === `y*373 + m*31`** → identical bin-packing output (same shuffle, same per-day placement).
4. **`nextCycle`** of a monthly cycle === the next calendar month → identical cron timing.
5. Default everywhere is `1` when no `user_review_settings` row exists.
6. **`daily_review_enabled` defaults to `true`** — a missing row, or a row with the column absent, reads as enabled. No existing user is silently turned off.

Add a unit test asserting all five for a spread of months (incl. December→January and leap February). If any fails, monthly users would see their assignments reshuffle — the one outcome we must never ship.

---

## 9. Rollout phases

**Phase 1 — Plumbing, invisible.** Run the migration. Add `lib/cycle.ts` + `lib/binPack.ts`. Refactor all routes + `daily/page.tsx` to read `getUserFrequency` and route through the cycle helpers. With no settings rows, every user is `freq=1` and behavior is provably identical (§8). Ship. Watch for regressions before any UI exists.

**Phase 2 — Expose the controls.** Add the settings frequency selector + the "Apply new frequency" re-portion flow + the **on/off toggle** + the copy/label changes. Now a user can opt into bimonthly/quarterly or turn review off. The on/off toggle is independent of and simpler than the frequency re-portion flow — it can ship first within this phase (it touches no cycle math, just the `enabled` guards and the future-assignment cleanup) if you want the lower-risk half of Phase 2 out the door earlier.

**Phase 3 — Cron.** Switch `vercel.json` to the daily schedule with the per-user guard. (Can also ship in Phase 1 since it's equivalent for `freq=1`; just verify the idempotency guard first.)

Splitting like this means the risky distribution refactor lands and bakes *before* any user can change frequency, so a bug can't corrupt a non-monthly user's data on day one.

---

## 10. Test matrix

| Scenario | What to assert |
|----------|----------------|
| **freq=1 regression** | Assignments/keys/seed byte-identical to pre-change (see §8). The most important test. |
| Bimonthly steady state | Each highlight appears once across the ~60-day cycle; per-day score balanced. |
| Quarterly steady state | Once per ~90-day cycle; lighter days. |
| Dec→Jan rollover | Quarterly Oct–Dec then next cycle Jan–Mar; `nextCycle` crosses the year. |
| Leap February | `freq` cycle including Feb 2028 has 29 days; date list correct. |
| Add highlight mid-cycle | `redistribute` places it on remaining cycle days + future portioned cycles only. |
| Last day of cycle | Orphans (never assigned this cycle) land on the final day. |
| Switch freq mid-cycle | Re-portion preserves rated days; future misaligned cycles cleared. |
| Widget catch-up | Pulls unreviewed items from cycle start (not calendar-month start). |
| Timezone | Cycle boundaries use the client `localDate` the routes already pass, not server UTC. |
| Stats / "Last reviewed" | Counts a full cycle; label renders the month range. |
| Cron idempotency | Running `prepare-next-cycle` twice in a day portions the next cycle exactly once. |
| **Review disabled** | With `daily_review_enabled = false`: cron skips the user, `assign`/`redistribute` are no-ops, widget + `review/next` return empty, `/daily` shows the off state. No new `daily_summaries` rows created. |
| Disable clears future | Turning off deletes future **un-rated** assignments but leaves past rated days, `daily_summary_highlights.rating`, and `highlight_months_reviewed` intact. |
| Re-enable resumes | Turning back on re-portions the current cycle at the **stored** `frequency_months` (not reset to monthly); past stats unchanged. |
| Enabled default | A user with no settings row (or pre-column row) reads as enabled — never silently off. |

---

## 11. Known caveats / out of scope

- **`resurface_count` after a frequency change.** The live trigger computes `COUNT(*)` of `highlight_months_reviewed` rows per highlight, which is "distinct cycles reviewed" — correct going forward. The *one-time backfill* in `migration_resurface_stats.sql` used `to_char(date,'YYYY-MM')` (calendar months); it has already run and is not re-run, so no action needed unless you want to recompute historical counts as cycles (would require cycle math in SQL — low value, document and skip).
- **Per-highlight / per-category cadence** — explicitly out of scope (D2).
- **"Twice a month" cadence** — out of scope (D1); would be a sub-month split, a different mechanism.
- **Mid-cycle frequency changes** are inherently lossy at the boundary (a partially-reviewed cycle can't cleanly re-tile). The "Apply new frequency" flow preserves rated days and re-portions the rest; communicate this in the confirm dialog.
- **`offlineStore` field names** stay `month*` unless renamed; purely cosmetic.
- **Turning review off mid-cycle is intentionally lossy for the *current* partial cycle's unreviewed items** — they're cleared, not parked. Re-enabling re-portions from scratch for the current cycle; it does not restore the exact pre-off assignment of un-rated highlights (rated history is always preserved). This matches the frequency-change boundary behavior and is communicated in the off confirm dialog.
- **Streaks / "Last reviewed" while off.** With no new assignments, streak-style stats naturally go quiet. Decide whether the UI should freeze the streak or show "paused" — out of scope for the data layer, but flag it for the settings/stats copy so an off user isn't told they "broke their streak."
</content>
</invoke>
