# Configurable Review Frequency — Implementation Plan

**Status:** Design / not yet implemented
**Goal:** Let a user review their highlights on a cadence other than monthly — e.g. **every 2 months (bimonthly)**, **every 3 months (quarterly)**, all the way up to **once a year** — instead of the hardcoded one-calendar-month cycle. And let a user **turn daily review off entirely** if they don't want any resurfacing.
**Author:** prepared as a future-implementation spec. Read this top-to-bottom before writing any code.

---

## 0. TL;DR

Today the app equates **one review cycle == one calendar month**. Every highlight resurfaces exactly once per calendar month, bin-packed across the days of that month by character count. That equivalence is hardcoded in ~17 places.

The change is to introduce a **cycle abstraction** (`frequency_months ∈ {1, 2, 3, …, 12}`, monthly through yearly) and replace "calendar month" with "cycle" everywhere. A cycle is `N` contiguous, **calendar-aligned** months. Each highlight resurfaces once per cycle, spread across all days of the cycle (so a quarterly cycle is ~90 days and each day is ~⅓ as heavy — exactly the lighter cadence you want).

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

### D6 — `frequency_months` ranges 1–12 (monthly … yearly) — **confirmed**
The supported range is **1 through 12**, so a user can go all the way to a **one-year cycle** (the calendar year). The `CHECK (frequency_months BETWEEN 1 AND 12)` already permits it; this decision makes yearly a first-class, exposed choice rather than just a tolerated value.
- `freq = 12` aligns to the January epoch (D3), so a yearly cycle is exactly **Jan 1 – Dec 31** of the containing year. `nextCycle` rolls to the next calendar year. `cycleSeed` = `startYear*373 + 1*31` (start month is always January), distinct per year. Each highlight resurfaces once across ~365–366 days — the lightest cadence.
- **Selector restricts to divisors of 12: `{1, 2, 3, 4, 6, 12}`.** The cycle math works for *any* 1–12, but only divisors of 12 produce cycles that align to year boundaries; a non-divisor like 5 yields cycles that drift across the calendar year (e.g. Nov–Mar), which is correct-but-confusing. Offer Monthly / Every 2 months / Every 3 months / Every 4 months / Every 6 months / Yearly.
- The bin-packer already handles a 365/366-element date list (it packs explicit dates, §6.0). The redistribute future-cycles cap (§6.3) stays at ~3 cycles regardless of length.

### D7 — Mid-cycle frequency change: greedy past-fill + deterministic restore — **confirmed**
Changing frequency mid-cycle re-tiles the library onto a differently-shaped cycle. Two properties govern the re-portion (the "Apply new frequency" flow, §6.8):

1. **Already-rated highlights greedily back-fill the past days of the new cycle.** When the new cycle's span differs from the old one, any highlight the user *already reviewed* this period must register as **done** — it must never resurface as "due." So rated highlights are packed onto the new cycle's **past days** (`date < today`), earliest-and-lightest first, and an `highlight_months_reviewed` row is written under the **new** cycle key. Only genuinely-unreviewed highlights get packed onto the **remaining** days (`date >= today … endDate`). This concentrates outstanding work on the future and leaves the past reading as completed.
2. **Switching back to a prior frequency restores the prior per-day distribution as closely as possible.** Because `packIntoDates` is a pure function of (item set, date list, seed) and `cycleSeed` depends only on the cycle's start month (not on "today" or call time), re-packing an unchanged library for a previously-used frequency reproduces the earlier layout **byte-identically for the unreviewed portion**; preserved rated days are literally the same rows. A freq round-trip (A→B→A) is therefore as close to lossless as the rated/unrated split allows. The re-portion must rely on this determinism — i.e. *preserve* rated day-assignments and *re-pack* only the unrated remainder — rather than reshuffling everything, or the round-trip property is lost.

These two are in mild tension (greedy past-fill deviates from a pure full re-pack), so the contract is **best-effort**: rated days are preserved/relocated faithfully; the unrated remainder is restored deterministically. The confirm dialog should still note that a partially-reviewed cycle can't be re-tiled perfectly.

### D8 — Consecutive cycles are never identical (cross-cycle freshness) — **confirmed**
A deterministic packer must still hand the user a *fresh* layout each cycle — they should not review the same highlights on the same relative days, in the same order, cycle after cycle. Seeding off the cycle **start** (not a constant, not "today") is what delivers this, and it's the same mechanism that gives the D7 round-trip — just viewed the other way:

- **`cycleSeed` is collision-free over the whole supported range.** `cycleSeed = startYear*373 + startMonth*31`. Two distinct cycles would share a seed only if `373·Δyear = 31·Δmonth`; with `startMonth ∈ 1..12`, `|31·Δmonth| ≤ 341 < 373`, so the only solution is `Δyear = Δmonth = 0`. **Every distinct cycle gets a distinct seed** — consecutive cycles (and all cycles, ever) never reuse a packing seed. (`seededShuffle` must mix the seed well so seeds 31 apart yield uncorrelated permutations; the existing implementation does.)
- Because the seed feeds both `seededShuffle` (pre-pack item order) and the per-bucket reshuffle (§6.0 step 4), **the day each highlight lands on and its order within the day rotate every cycle.** No two consecutive cycles are byte-identical.
- **Caveat — groupings are score-driven, not seed-driven.** The LPT pack (sort-desc-by-score → assign-to-lightest-day) decides *which highlights share a day* mostly from their character-count scores; the seed mainly relabels which calendar day each cluster maps to and the intra-day order. So with a small, unchanging library the same clusters can recur on different days. **This is precisely today's monthly behavior**, and §8 invariant #3 requires freq=1 to stay byte-identical — so we deliberately do **not** change it here. Varying the groupings themselves (true reshuffle) is a separate, explicit packer change — e.g. a small `cycleSeed`-derived per-item score jitter before the sort — that would also alter freq=1 output and so needs its own regression baseline. **Flagged, not adopted** in this feature.
- **Relationship to D7.** Identical seeds recur only for the *same* cycle key (round-trip restore, A→B→A on the same month). A *different* cycle always has a different seed. "Restore on round-trip" and "fresh every cycle" are one mechanism.

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

> **Why `cycleSeed` matters:** the bin-packer is seeded by `year*373 + month*31` today. Using the cycle's **start** month keeps the seed (and therefore the exact assignment) identical for `freq=1`. Don't seed off "today" or the viewed month — seed off the cycle start. This single choice serves two goals at once (D8): it's **injective over (year, month)** — provably collision-free, so every cycle's layout differs from its neighbors — *and* it's **stable for a given cycle**, so a frequency round-trip restores the prior layout (D7). Do not replace it with a constant or a time-based seed, which would make consecutive cycles repeat.

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

**For the frequency-change re-portion (D7), `packIntoDates` is enough** — call it twice over disjoint date sub-ranges: once over the cycle's *past* dates with the already-rated items (greedy back-fill), once over the *remaining* dates with the unrated items, both seeded by `cycleSeed(newCycle)`. No separate pinned-packer is needed; just feed it the two date slices. Because the second call uses the full-cycle seed, the unrated layout matches what a clean full re-pack of that frequency would produce over those same remaining dates (the D7 round-trip property).

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
- Add a **frequency selector** over the divisors of 12 (D6): Monthly (1) / Every 2 months (2) / Every 3 months (3) / Every 4 months (4) / Every 6 months (6) / **Yearly (12)**. Persists to `user_review_settings`. (Hidden/disabled while review is off.)
- **Changing frequency reshapes cycles**, so on change show a confirm and then run the **"Apply new frequency" re-portion** (the D7 algorithm below). Treat this as an explicit action, not a silent toggle.

#### "Apply new frequency" re-portion (D7)
Given `freq_old → freq_new` and the client's `today`:
1. `newCycle = getCycleForDate(today, freq_new)`.
2. **Determine the done-set R.** R = unarchived highlights that already have a `daily_summary_highlights.rating` on some `date` in `[newCycle.startDate, today]` (ground truth is the per-day rating, which survives any key change). U = remaining unarchived highlights (the unreviewed remainder).
3. **Preserve rated day-assignments in place** when their `date` already lies within `[newCycle.startDate, today]` — do not move a highlight off a past day the user actually reviewed it on. (Monthly→longer is a superset, so every rated day is preserved untouched.)
4. **Greedily back-fill the rest of R onto past days.** For rated highlights whose original day now falls *outside* `newCycle` (longer→shorter shrinks the span), pack them onto `newCycle`'s past dates (`date < today`) via `packIntoDates(thoseItems, pastDates, cycleSeed(newCycle))`, lightest-first, so they register as completed and never resurface.
5. **Re-pack U onto the remaining days.** `packIntoDates(U, remainingDates, cycleSeed(newCycle))` where `remainingDates = newCycle.dates.filter(d => d >= today)`. Using the full-cycle seed is what gives the D7 round-trip property (switching back reproduces this layout).
6. **Re-key the dedup ledger in place (don't add a second row).** Every highlight in R needs exactly one `highlight_months_reviewed` row for the current period, keyed to `newCycle.key`, so it's excluded from re-assignment this cycle. But it likely *already* has a row under the **old** current-cycle key (from when it was rated under `freq_old`). Writing a new-key row without removing the old one would leave two rows for the same review, and since the trigger sets `resurface_count = COUNT(DISTINCT month_year)`, the count would tick up by one for no real reason. So **rename, don't insert**: for each highlight `X` in R, compute `oldKey = getCycleForDate(X.ratingDate, freq_old).key`, then in one statement `DELETE FROM highlight_months_reviewed WHERE highlight_id = X AND month_year = oldKey` and `INSERT (X, newCycle.key) ON CONFLICT DO NOTHING`. This replaces one row with one row → distinct-key count (and `resurface_count`) is exactly preserved. Scope the delete to that one `oldKey` only — `X`'s rows for *other*, earlier periods (e.g. a March review) must stay untouched. If `oldKey === newCycle.key` (the change didn't move the start month), it's a harmless no-op.
7. **Clear future pre-portioned cycles** whose boundaries no longer align with `freq_new` (delete future, un-rated `daily_summaries` past `newCycle.endDate`; the daily cron will re-portion the next cycle when due).

Implementation: `reset-cycle` (clears the current-cycle window + its HMR key) followed by an `assign` variant that accepts the precomputed R/U split, rather than a blind full re-pack — `assign` already preserves completed days, so the main addition is steps 4 + 6.
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

### 8a. Data-safety invariant (rated rows are sacred)

A **rated `daily_summary_highlights` row** and its matching **`highlight_months_reviewed` (ledger) row** are the permanent record of a review. They are coupled and must **always move together**:

- **No reassignment path may delete a rated row** (`rating IS NOT NULL`) on its own. Deleting the day-row while the ledger still flags the highlight "reviewed" makes it excluded from every future re-pack *and* present on no day → **stranded / invisible** (this caused the off→on data loss and the empty June 1/17 days).
- The **only** path allowed to remove a rated row is `reset-cycle`, and it deletes the ledger row in the same operation (an explicit user reset of the whole cycle).
- All repack paths (`assign`, `redistribute`, `apply-frequency`, including any future cycle-frequency change) must therefore:
  - delete **only** unrated rows (`.is('rating', null)`), or be purely additive;
  - **preserve every rated row in place** and exclude already-rated highlights from re-packing;
  - seed per-day load with the preserved rated score (`packIntoDates(..., initialLoads)`) so day **totals** stay balanced.
- **Postcondition** to uphold: for any cycle, *every* highlight in `highlight_months_reviewed[cycleKey]` has a rated row somewhere in that cycle's days. (Verify with a count of "reviewed-but-not-on-calendar" == 0.)

Current status: `assign` enforces this (rated-only-preserve + unrated-only-delete); `apply-frequency` follows the anchored model below; `redistribute` is additive; `reset-cycle` deletes both together. ✓

### 8b. Cadence change — anchored & reversible model (`apply-frequency`)

A frequency change is **one unified operation** for both grow and shrink; the direction just falls out of which cycle `today` lands in. It rests on a single principle that subsumes §8a:

- **A rated row is an immutable anchor** — never moved, never deleted (its date is the truth of when you reviewed it). Only **unrated (to-do) rows** are ever recomputed.
- **"Done for cycle C" = the highlight has a rated row dated inside C.** When *growing*, scanning the whole (larger) cycle is the **cross-month duplicate check**: a highlight still to-do in the current month but already reviewed in another month of the bigger cycle is found here, kept done, and never re-queued.
- The unreviewed remainder (`active − doneIds`) is packed across `[today … cycle end]` by `cycleSeed(cycle)`, each pack day pre-loaded with the score of the rated rows already on it (`packIntoDates(..., initialLoads)`) so per-day **totals** stay balanced. Done highlights pool naturally in the past (they were reviewed on earlier dates); to-do sits ahead.
- The ledger for the cycle key is rebuilt to equal `doneIds` (minimal diff) so the cron/`assign` agree on what's done.

**Reversibility (plan requirement):** the to-do layout is a *pure function* of `(cycle, today, active highlights, doneIds, ratedScoreByDate)` — extracted as `lib/retile.ts#computeToDoLayout`. `doneIds` and `ratedScoreByDate` derive only from immutable rated rows, so returning to a cadence with no new reviews reproduces its exact layout. Round-trips (`1→3→1`, `3→1→3`, `1→3→12→3→1`) are asserted in `__tests__/retile.test.ts`. Consequence: a longer cadence genuinely means each highlight resurfaces less often; nothing is ever deleted.

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
| **Greedy past-fill (D7)** | Switch longer→shorter mid-cycle: already-rated highlights land on the new cycle's **past** days (`< today`) and get an HMR row for the new key; none reappear as "due." Unrated highlights occupy only `>= today`. |
| **Freq round-trip (D7)** | A→B→A with an unchanged library: after returning to A, the unreviewed remainder's per-day layout is byte-identical to the original A layout (determinism of `packIntoDates` + `cycleSeed`); preserved rated days are the same rows. |
| **`resurface_count` precise across freq change** | A highlight reviewed once this period has `resurface_count` *unchanged* after one or more frequency changes — the HMR re-key renames the current-period key (one row → one row), and earlier-period rows are untouched. |
| **Consecutive cycles differ (D8)** | Same library, cycle N vs N+1 (any frequency): assignment is **not** byte-identical — distinct `cycleSeed` rotates the day each highlight lands on and its intra-day order. Also assert `cycleSeed` is injective across a wide month span (no two cycles collide). |
| **Yearly cycle (freq=12)** | Cycle spans Jan 1–Dec 31; each highlight appears exactly once across the year; `nextCycle` rolls to next Jan; leap-year date list has 366 days. |
| Selector range | Only divisors of 12 `{1,2,3,4,6,12}` are offered; each produces year-boundary-aligned cycles. |
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

- **`resurface_count` after a frequency change.** The live trigger computes `COUNT(DISTINCT month_year)` per highlight, i.e. "distinct cycles reviewed." The D7 re-portion keeps this **exactly precise** by *renaming* the current period's HMR key (old → new) instead of inserting a second row (§6.8 step 6): one row replaces one row, so the count is unchanged for a highlight that was genuinely reviewed once this period. The *one-time backfill* in `migration_resurface_stats.sql` used `to_char(date,'YYYY-MM')` (calendar months); it has already run and is not re-run, so no action needed unless you want to recompute historical counts as cycles (would require cycle math in SQL — low value, document and skip).
- **Per-highlight / per-category cadence** — explicitly out of scope (D2).
- **Grouping-level reshuffle across cycles** (seed-derived score jitter so the *same highlights* don't keep clustering together) — explicitly out of scope (D8). We **emulate today's behavior exactly**: the day and intra-day order rotate per cycle, but groupings stay score-driven, because invariant #3 requires freq=1 to be byte-identical to the current packer. Do not add jitter as part of this feature.
- **"Twice a month" cadence** — out of scope (D1); would be a sub-month split, a different mechanism.
- **Mid-cycle frequency changes** can't re-tile a partially-reviewed cycle *perfectly* — but D7 makes the behavior principled, not arbitrary: already-rated highlights greedily back-fill the new cycle's past days (so they read as done), the unreviewed remainder is packed deterministically onto the remaining days, and switching back to a prior frequency restores the earlier per-day layout for that remainder. The residual loss is only at the rated/unrated boundary; communicate this in the confirm dialog.
- **`offlineStore` field names** stay `month*` unless renamed; purely cosmetic.
- **Turning review off mid-cycle is intentionally lossy for the *current* partial cycle's unreviewed items** — they're cleared, not parked. Re-enabling re-portions from scratch for the current cycle; it does not restore the exact pre-off assignment of un-rated highlights (rated history is always preserved). This matches the frequency-change boundary behavior and is communicated in the off confirm dialog.
- **Streaks / "Last reviewed" while off.** With no new assignments, streak-style stats naturally go quiet. Decide whether the UI should freeze the streak or show "paused" — out of scope for the data layer, but flag it for the settings/stats copy so an off user isn't told they "broke their streak."
</content>
</invoke>
