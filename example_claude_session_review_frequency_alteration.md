# Review Frequency Spec — Chat History

_Exported transcript of the work that produced `REVIEW_FREQUENCY_PLAN.md`._
_Excludes the unrelated `/review/lite` redirect work from the current session._



---

## Session 1 — Origin: plan & create the spec
_2026-06-06 · `f97fce20`_


### 🧑 User

plan out how you would add customization for different review frequencies besides just monthly, like if you wanted bimonthly or quarterly. examine what would need to change


**🤖 Claude:**

I'll explore the codebase to understand how review frequencies currently work before planning the change.


**🤖 Claude:**

> 🔧 `Bash` git ls-files | head -100 && echo "---STRUCTURE---" && ls -la


**🤖 Claude:**

> 🔧 `Bash` grep -rni "monthly\|frequency\|interval\|review.*period\|cadence" --include="*.t…


**🤖 Claude:**

This is a spaced-repetition highlights app organized around a **monthly** review cycle. Let me dig into the core mechanics.


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/supabase/schema.sql


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/lib/redistribute.ts


**🤖 Claude:**

Let me read the canonical schema and the daily-distribution logic, which is the heart of the review cycle.


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/supabase/migration_complete…


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/api/daily/redistribute/…


**🤖 Claude:**

This confirms the monthly cycle is deeply baked in. Let me read the other daily routes and the key frontend pages to map the full surface area.


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/api/daily/assign/route.…


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/api/daily/prepare-next-…


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/api/daily/reset-month/r…


**🤖 Claude:**

Now let me look at the frontend (daily page, settings) and the cron config to understand the user-facing surface and scheduling.


**🤖 Claude:**

> 🔧 `Bash` cat /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/vercel.json; echo "===C…


**🤖 Claude:**

> 🔧 `Bash` grep -n "month\|Month\|daysInMonth\|/api/daily\|prepare-next\|reset-month\|assig…


**🤖 Claude:**

I've now mapped the full surface. Here's my plan.

## The core insight

The entire app equates **one review cycle = one calendar month**. That equivalence is hardcoded in ~6 places and is the single thing you have to break. Today:

- `prepare-next-month` (cron, monthly on the 24th) bin-packs **all** unarchived highlights across the days of next month, balancing by character-count "score" — so each highlight resurfaces **once per month**, on one day.
- `highlight_months_reviewed (highlight_id, month_year)` is the dedup ledger: "this highlight was already reviewed in `YYYY-MM`," so it won't be re-placed within the same month.
- `daily_summaries.date` + `daily_summary_highlights` hold the per-day assignment.
- The distribution window is literally `daysInMonth` (days 1..28-31), and the cycle key `monthYear = "YYYY-MM"` is threaded through every daily route.

"Bimonthly / quarterly" means: **make the cycle N calendar months instead of 1.** Each highlight resurfaces once per cycle, spread thinner across ~60 or ~90 days (which is exactly the lighter-cadence UX you'd want). So the work is replacing the "calendar month" abstraction with a "cycle" abstraction everywhere.

## Two decisions that change the shape of the plan

1. **"Bimonthly" is ambiguous** — every *two months* (longer cycle) vs *twice a month* (shorter cycle). Paired with "quarterly," I'm assuming you mean **longer cycles: every N months**. Twice-a-month would instead mean splitting the library into 2 sub-cycles within a month — a different (and easier) variant.
2. **Global vs per-highlight frequency.** Simplest meaningful version: **one cadence per user** (whole library on the same frequency). Per-highlight or per-category cadence is far more complex (mixed cycles overlapping on the same days) and I'd treat it as a separate, later project. The plan below assumes per-user global.

## What changes, by layer

### 1. New shared cycle module — `lib/cycle.ts` (the foundation)
Right now every route inlines `daysInMonth = new Date(year, month, 0).getDate()` and builds `YYYY-MM-DD` strings for days 1..daysInMonth. Replace with one helper:
- `getCycle(date, frequencyMonths, anchor)` → `{ startDate, endDate, key, dates: string[] }`
- `cycleKey(date, freq, anchor)` → e.g. `"2026-Q1"` or the cycle-start `"2026-01"`
- iterate **actual dates across multiple calendar months**, not a 1..31 index.

This is the linchpin — everything else consumes it.

### 2. Schema (new pending migration)
- **`user_review_settings`** (or a column on an existing per-user table): `frequency_months INTEGER DEFAULT 1`, plus optionally `cycle_anchor DATE` to define where cycles start.
- **`highlight_months_reviewed`** semantics shift to "reviewed in this **cycle**." Cleanest: keep the table, repurpose `month_year` as a generic `cycle_key`. For monthly (N=1) the key stays `YYYY-MM`, so **all existing rows remain valid** — zero data migration for current users.
- `daily_summaries` needs **no structural change** (it's already keyed by `date`); cycles just span more dates.

### 3. The distribution algorithm (`assign`, `prepare-next-month`)
The bin-packer `assignHighlightsToDays(highlights, daysInMonth, year, month)` builds a `days` array of length `daysInMonth` and emits a `day: number` (1..31). That **breaks across month boundaries** — a 90-day cycle can't collapse into one month index. Required change:
- `DayAssignment.day: number` → `date: string`. Carry real ISO dates, not day-of-month.
- length `daysInMonth` → `dates.length` from the cycle.
- The character-count balancing logic itself generalizes for free — more days just means lighter days.

This is the most invasive single edit; it ripples through both `assign/route.ts` and the duplicated copy inside `prepare-next-month/route.ts` (the algorithm is copy-pasted — worth extracting to a shared lib while you're here).

### 4. Cron scheduling — the trickiest operational change
`vercel.json` fires `prepare-next-month` on a fixed calendar date (`0 0 24 * *`). That only works when every user's cycle boundary is the same monthly date. With per-user frequencies and anchors, **boundaries differ per user.** Fix:
- Change the cron to **daily** (`0 0 * * *`).
- Make the endpoint (rename → `prepare-next-cycle`) per-user-aware and idempotent: for each user, compute "does their next cycle start within the lead window (~7 days) and isn't prepared yet? If so, portion it." Monthly users behave identically to today.

### 5. The other daily routes
- **`redistribute`** (mid-cycle adds): "remaining days in this **month**" → "remaining days in this **cycle**"; the `futureMonthsToAssign` look-ahead loop → future **cycles**. Same bin-packing-into-lightest-day logic.
- **`reset-month` → `reset-cycle`**: operate on the current cycle window instead of `startDate`/`endDate` of the month.
- **`cleanup`**: date-based, essentially unaffected.
- **`review/next`, `review/widget`**: read *today's* assignments by date — verify, but should be untouched.

### 6. Frontend
- **`app/daily/page.tsx`** (2,300 lines, month-grid calendar via date-fns `startOfMonth`/`endOfMonth`): the calendar can stay a month-by-month **date browser** — days outside the active cycle just have no assignments. Lowest-effort path. Copy referencing "this month" → "this cycle."
- **`app/settings/page.tsx`**: add a **frequency selector** (Monthly / Every 2 months / Quarterly); "reset monthly highlights" → "reset cycle"; "last month reviewed" → "last cycle."

### 7. Frequency-change migration (don't skip this)
Switching monthly→quarterly mid-stream must re-portion **future, unreviewed** assignments while **preserving already-rated days**. So the settings toggle should trigger a reset-cycle + re-assign for the current/future window, with a warning. This is the easiest piece to forget and the most likely to corrupt state.

## Edge cases to nail down
- **Anchoring**: calendar-aligned quarters (Jan–Mar) vs anchored to signup date. Calendar-aligned is predictable and simplest — recommend that.
- **Partial first cycle** when a user switches frequency mid-cycle.
- **Timezone**: cycle boundaries must use the same client-`localDate` approach the routes already use, not server UTC.
- The duplicated bin-packing algorithm in 3 routes — consolidate during this work or the cycle bug surfaces in only some of them.

## Effort estimate
- `lib/cycle.ts` + schema migration + settings toggle: **small-to-medium**, low risk.
- Generalizing `assign` + `prepare` (day-number→date) and the cron-per-user logic: **the bulk of the work**, medium risk (state correctness).
- Frontend copy + reset-cycle: **small**.
- Frequency-change re-portioning: **small but correctness-critical**.

The good news: defaulting `frequency_months = 1` makes the whole thing a **no-op for existing users** — monthly stays bit-for-bit identical, so you can ship behind that default and only exercise the new paths for users who opt in.

Want me to drill into any layer — e.g. draft `lib/cycle.ts` and the exact `assign`/`prepare` diffs, or spec the cron-per-user logic in detail?


### 🧑 User

can you prepare these details and implementation plans to write up as an .md which we may implement in the future. make sure the new version will work perfectly make no mistakes


**🤖 Claude:**

Before writing, let me verify the remaining surfaces so the plan is precise and doesn't miss anything — the review/widget routes, stats, settings page, the daily page internals, and migration conventions.


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/settings/page.tsx


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/api/review/next/route.t…


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/api/review/widget/route…


**🤖 Claude:**

Key finding: the widget's "catch-up" logic (`firstOfMonth = today.substring(0,8) + '01'`) is another month-boundary assumption. Let me read the stats routes, the daily page's rating handler (where `highlight_months_reviewed` is written), and the offline store to complete the map.


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/api/stats/reviewed-coun…


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/api/stats/reviewed-coun…


**🤖 Claude:**

Now let me look at where the daily page writes `highlight_months_reviewed` (the rating handler) and the migration conventions doc, to ground the write-up accurately.


**🤖 Claude:**

> 🔧 `Bash` grep -n "highlight_months_reviewed\|month_year\|monthYear\|getMonth\|prepare-nex…


**🤖 Claude:**

> 🔧 `Bash` cat supabase/MIGRATIONS.md 2>/dev/null | head -80; echo "===OFFLINE GREP==="; gr…


**🤖 Claude:**

Let me read the daily page's rating handler and assign-trigger sections, plus the resurface-stats migration (which counts "distinct months reviewed").


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/daily/page.tsx


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/app/daily/page.tsx


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/supabase/migration_resurfac…


**🤖 Claude:**

I have a complete and accurate map of every month-coupled surface. Writing the implementation plan now.


**🤖 Claude:**

API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()


### 🧑 User

please continue


**🤖 Claude:**

> 🔧 `Write` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

I've written the full implementation plan to `REVIEW_FREQUENCY_PLAN.md` at the repo root (matching your existing top-level doc convention like `AUTO_IMPORT_SETUP.md`).

## What's in it

A complete, build-ready spec grounded in the actual code I read — not generic advice. Highlights:

**The core idea** — the app hardcodes `1 review cycle == 1 calendar month` in **17 places** (I tabulated every one with file paths). The plan replaces "calendar month" with a **cycle** abstraction (`frequency_months ∈ {1,2,3}`), calendar-aligned so quarterly = Jan–Mar for everyone.

**The "make no mistakes" guarantees** — the plan is built around one property: with `frequency_months = 1` (default), the cycle key, date list, and bin-packing seed are **byte-identical** to today. I included:
- A reference `lib/cycle.ts` I verified by hand against worked examples (monthly identity, bimonthly, quarterly, year-boundary).
- §8 **Backward-compat invariants** — 5 assertions that must hold (incl. `cycleSeed === year*373 + month*31`, the existing seed), with a required unit test. If any fails, monthly users' assignments would reshuffle — the one thing we must never ship.
- **Zero data migration**: the existing `highlight_months_reviewed.month_year` column is reinterpreted as the cycle key, and for monthly users the key *is* the calendar month, so old rows stay valid.

**The non-obvious traps I surfaced** (each found in the code, not guessed):
- The bin-packer emits `day: number (1..31)` — meaningless across a multi-month cycle, so it must become `date: string`. Ripples through 3 routes (which share copy-pasted code → extract `lib/binPack.ts` first).
- The cron can't stay a fixed monthly date once boundaries differ per user → must go **daily** with a per-user "within 7 days of cycle end + not already portioned" guard (idempotency now mandatory).
- The widget's `firstOfMonth = today.substring(0,8)+'01'` catch-up and the stats routes' "previous calendar month" defaults are separate month-boundary assumptions.
- `handleRatingChange` writes the dedup key in **two** sites in `daily/page.tsx` — miss one and dedup breaks.

It also has the migration SQL (RLS-correct, idempotent), file-by-file change specs, a 3-phase dark-launch rollout, a 12-row test matrix, and an explicit out-of-scope section (per-highlight cadence, "twice a month").

One thing worth deciding before implementation, which I flagged as decision **D1**: I assumed "bimonthly" means *every two months* (a longer cycle, pairs naturally with quarterly). If you actually meant *twice a month*, that's a different mechanism and the plan would need a different shape — worth confirming when you pick this up.


### 🧑 User

bimonthly means every two months you can change this


**🤖 Claude:**

Good — that's exactly what the plan assumed, so no design changes needed. Let me update the doc to state it as settled rather than an open question.


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Done. `REVIEW_FREQUENCY_PLAN.md` now states it as settled — bimonthly = every two months (`frequency_months = 2`, ~60-day cycle).

That was already the assumption the whole plan was built on, so nothing else changes: the cycle math (`freq=2` → Jan–Feb, Mar–Apr, …), the schema `CHECK (frequency_months between 1 and 12)`, the settings selector (Monthly / Every 2 months / Quarterly), and the test matrix all stay as written. The only edit was removing the "confirm this before implementing" hedge.



---

## Session 2 — Add 'turn off daily review' option
_2026-06-17 · `8f49bbc3`_


### 🧑 User

[ran command: /clear]


### 🧑 User

to the review frequency plan, also give users the option to turn off daily review if they wish


**🤖 Claude:**

> 🔧 `Bash` ls *.md 2>/dev/null; echo "---plans---"; find . -path ./node_modules -prune -o -…


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

This is a plan-editing task. Let me weave the "turn off daily review" option through `REVIEW_FREQUENCY_PLAN.md` so it stays consistent with the rest of the spec. I'll add it as an orthogonal on/off flag rather than overloading `frequency_months`.

Let me make the edits across the relevant sections.


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now the design decisions section:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now Section 4 — extend the settings helper to carry the enabled flag:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now Section 5 — the migration column:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now the file-by-file spec. Let me add the enabled guard at each entry point. First the cron/prepare route (6.2):


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now the `/daily` page (6.7):


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now the settings page (6.8):


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Section 7 (cron) — fold the enabled check into the per-user decision:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now Section 8 (invariants), 9 (rollout), 10 (test matrix), 11 (caveats):


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Done. I threaded the "turn off daily review" option through `REVIEW_FREQUENCY_PLAN.md` as a control orthogonal to frequency, so it composes cleanly without disturbing the cycle math or the §8 backward-compat invariants.

What I added:

- **TL;DR** — introduced `daily_review_enabled ∈ {true, false}` as a second, independent control; off→on preserves the chosen cadence.
- **D5 (new design decision)** — why it's a boolean, not `frequency_months = 0`: keeps cycle math total, preserves cadence across toggles, and is just an early-return at each entry point. Off stops *new* assignments and clears *future un-rated* ones but keeps all reviewed history.
- **§4 helper** — replaced `getUserFrequency` with `getUserReviewSettings → { freq, enabled }` (kept the old one as a thin wrapper); called out that "missing row = enabled" is load-bearing.
- **§5 migration** — added `daily_review_enabled BOOLEAN NOT NULL DEFAULT TRUE` plus an idempotent `ADD COLUMN IF NOT EXISTS` in case frequency ships first.
- **§6 routes** — `!enabled` early-outs in assign, prepare-next-cycle (cron), redistribute, widget, and `review/next`; an "off" empty state on `/daily`; and a settings on/off toggle with off (confirm + clear future un-rated via `removeFromFutureMonths`) and on (re-portion current cycle at stored frequency) flows.
- **§7 cron** — skip disabled users in the per-user loop.
- **§8 invariant #6**, **§9 Phase 2** (toggle is the lower-risk half, can ship first), **§10 test matrix** (4 new rows), **§11 caveats** (mid-cycle off is lossy for current unreviewed items; flag streak/"Last reviewed" copy while off).

One thing I flagged rather than decided: what the streak UI should show while review is off (freeze vs. "paused") — that's copy/UX, not data-layer, so it's noted as out of scope in §11 for whoever does the settings work.



---

## Session 3 — Mid-month frequency change, resurface count, deterministic packing
_2026-06-18 · `a9f89ebf`_


### 🧑 User

The main thing to keep in mind for the multiple frequency months md plan is that if you’ve reviewed some highlights and then decide to change frequency midway through, those already rated highlights should probably “greedily” populate the earlier days already past. And if we switch back to previous frequency, we should try to match the previous per-day distribution as much as possible. Also, allow us to go all the way to one-year frequency circle.


**🤖 Claude:**

I'll find the plan file you're referring to.


**🤖 Claude:**

> 🔧 `Bash` ls -la *.md 2>/dev/null; echo "---PLANS---"; find . -iname "*frequen*" -not -pat…


**🤖 Claude:**

I found `REVIEW_FREQUENCY_PLAN.md`. Let me read it.


**🤖 Claude:**

> 🔧 `Read` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

This is a detailed implementation spec, and your three points refine the trickiest part of it (the mid-cycle frequency-change behavior) plus extend the range. Let me fold them into the plan directly. I'll make surgical edits.

First, the goal and TL;DR to reflect the extended range:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now the two new design decisions (D6 = range up to one year; D7 = mid-cycle change semantics):


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now extend the bin-packer interface (§6.0) to support the pinned/subset-date packing the re-portion needs:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now the settings page (§6.8): expand the selector to yearly and replace the vague re-portion bullet with the concrete D7 algorithm:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now the test matrix (§10) — expand the frequency-switch row and add yearly + round-trip coverage:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Finally, update the §11 caveats — the old text understated the mid-cycle behavior; reflect the D7 improvement and the resurface_count re-keying note:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

All three points are now folded into `REVIEW_FREQUENCY_PLAN.md`. Summary of what I changed:

**1. Greedy past-fill of rated highlights on frequency change** → new **D7** (§2) plus a concrete **"Apply new frequency" algorithm** in §6.8. The contract: already-rated highlights are packed onto the *new* cycle's **past days** (`date < today`), earliest-and-lightest first, and get a `highlight_months_reviewed` row under the new cycle key — so they read as *done* and never resurface as "due." Only genuinely-unreviewed highlights occupy `today … endDate`. Rated days already inside the new cycle's span are preserved in place (not moved).

**2. Match previous per-day distribution when switching back** → also D7, leaning on a property the plan already establishes: `packIntoDates` is a pure function of (items, dates, seed) and `cycleSeed` keys off the cycle's *start month*, not call time. So an A→B→A round-trip on an unchanged library reproduces the original unreviewed-portion layout byte-identically — *provided* the re-portion preserves rated days and re-packs only the remainder (rather than reshuffling everything). I noted the mild tension with greedy past-fill and made the contract explicitly best-effort. §6.0 clarifies this needs no new packer — just two `packIntoDates` calls over disjoint date slices.

**3. Up to one-year frequency** → new **D6** (§2). `freq` ranges 1–12 (the migration's `CHECK` already permits it). `freq=12` = the calendar year Jan 1–Dec 31 (January-epoch aligned), `cycleSeed = startYear*373 + 31`. The selector is restricted to **divisors of 12 `{1,2,3,4,6,12}`** because only those align to year boundaries — non-divisors like 5 are mathematically fine but produce cycles that drift across the year. Updated the §6.8 selector to include Yearly.

I also updated the goal/TL;DR range, the test matrix (greedy past-fill, freq round-trip, yearly/leap-year, selector range rows), and the §11 caveats (including the `resurface_count` re-keying interaction the D7 step-6 introduces).

One thing worth flagging for when this gets built: the `resurface_count` trigger counts distinct `highlight_months_reviewed` keys, so re-keying a rated highlight to the new cycle key can bump its count by one. I treated that as acceptable-and-documented rather than special-casing it — say the word if you'd rather the re-portion avoid writing a new key when a rating already exists under the old one.


### 🧑 User

what does this mean   One thing worth flagging for when this gets built: the resurface_count trigger counts distinct
  highlight_months_reviewed keys, so re-keying a rated highlight to the new cycle key can bump its
  count by one. I treated that as acceptable-and-documented rather than special-casing it — say the
  word if you'd rather the re-portion avoid writing a new key when a rating already exists under
  the old one.


**🤖 Claude:**

It's about an off-by-one in a stat counter. Let me unpack it with the actual mechanics.

**The pieces involved**

- `highlight_months_reviewed (highlight_id, month_year)` is the dedup ledger — one row means "this highlight was reviewed in this period." In the new design, `month_year` is reinterpreted as the **cycle key** (the cycle's start month).
- A DB trigger keeps `highlights.resurface_count = COUNT(DISTINCT month_year)` per highlight. So `resurface_count` literally means *"how many distinct review cycles has this highlight appeared in"* — it's the "you've resurfaced this N times" number shown to the user.

**The scenario**

1. You're on **monthly**. In June you review highlight X and rate it. That writes an HMR row: `(X, "2026-06")`. Its `resurface_count` = 1.
2. Mid-June you switch to **quarterly**. The new cycle is Apr–Jun 2026, whose key is `"2026-04"`.
3. D7 step 6 says: every already-rated highlight must get an HMR row under the *new* cycle key, so it's marked done and won't resurface this quarter. That writes `(X, "2026-04")`.

Now X has **two** HMR rows — `"2026-06"` and `"2026-04"` — so `COUNT(DISTINCT month_year)` = 2, and `resurface_count` ticks from 1 → 2. But the user only actually reviewed X *once*; the bump is purely an artifact of the key changing underneath it.

**The two ways to handle it**

- **What I wrote into the plan (accept + document):** let the count bump. It's rare (only highlights rated in the exact window where you then change frequency), and arguably defensible — you did review it across a cycle boundary. Simplest, no extra logic.
- **The alternative (special-case it):** before writing the new-key row in step 6, check whether the highlight already has an HMR row for an *overlapping/old* cycle covering the same dates, and if so either skip the write or delete the old-key row. Keeps `resurface_count` exactly truthful, at the cost of more fiddly re-keying logic.

So my flag was just: I picked the simpler "let it bump" path. If you'd rather the count stay precise, I'll change step 6 to dedup against the old key. Want me to?


### 🧑 User

count should be precise


**🤖 Claude:**

Good call — precise it is. I'll change the re-portion to **rename** the current-period key rather than add a second row, so the distinct-key count (and thus `resurface_count`) stays truthful. Updating step 6, the §11 caveat, and adding a test assertion.


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Done. The plan now keeps `resurface_count` exact across frequency changes:

- **§6.8 step 6** now says *rename, don't insert*: for each rated highlight, delete its old current-cycle-key HMR row and insert the new-cycle-key row in one shot (`ON CONFLICT DO NOTHING`). One row replaces one row, so `COUNT(DISTINCT month_year)` is unchanged. It also notes the delete must be scoped to that one old key so earlier-period rows survive, and that it's a no-op when the start month didn't move.
- **§11 caveat** rewritten from "acceptable bump" to "exactly precise."
- **§10 test matrix** has a new row asserting `resurface_count` stays unchanged across one or more frequency changes for a highlight reviewed once.

One subtlety I baked into the spec, worth knowing: the rename only touches the **current** cycle being re-portioned. If you go quarterly→monthly, reviews from earlier months of that quarter (e.g. May) keep the old quarter key rather than being re-keyed to a monthly key — they're historical and outside the current cycle, so the re-portion leaves them alone. That's consistent with "we only re-tile the current cycle," and it doesn't affect the count's precision (still one row per genuine review).


### 🧑 User

explain this, if i go quarter to month that means only future highlights will be reassigned to be monthly?


**🤖 Claude:**

Not quite — and the distinction matters, so let me lay it out concretely.

First, the key mental correction: **highlights aren't individually "monthly" or "quarterly."** Cadence is a global, per-user setting. Every cycle, your *entire* unreviewed library gets re-bin-packed across that cycle's days. So changing frequency isn't tagging some highlights "monthly" — it's reshaping the *cycle* that the whole library is tiled across, from the current cycle forward.

**Concrete example.** Say today is **May 15**, you're on **quarterly**, so your current cycle is **Apr 1 – Jun 30** (your whole library spread thin over ~90 days). You've reviewed some highlights Apr 1 → May 15. Now you switch to **monthly**. The new current cycle is **May 1 – 31**. Here's what happens to each bucket:

| Bucket | What happens |
|--------|--------------|
| **Past, already-completed** (April, and the quarter as a whole) | Left alone — history. April days are *not* retroactively re-cut into a monthly shape. |
| **Already-rated this period, days ≥ May 1** | Preserved in place on the day you reviewed them. |
| **Already-rated but on a day now outside the May cycle** (e.g. you reviewed it April 20) | Greedily back-filled onto May's past days (May 1–14) so it reads as *done* and won't resurface. |
| **The unreviewed remainder of your library** | Re-packed across the **remaining days of May** (May 15–31). |
| **Future** (June onward, previously pre-portioned as part of the quarter) | Cleared, then the cron regenerates them as **monthly** cycles when each comes due. |

So the answer to "only future highlights": **no.** Two things change, not just the future:

1. The **current in-progress cycle is reshaped** — your unreviewed highlights get compressed from "spread over the rest of the quarter" into "spread over the rest of *this month*." Because the window shrank, those days get **heavier** (that's the whole point of a more frequent cadence).
2. **Future cycles** regenerate at the new monthly cadence.

What does *not* happen: already-completed past days/cycles are frozen as-is. You won't see April retroactively rewritten.

And going the other way (month → quarter) is the mirror image: the unreviewed library spreads back out over ~90 days, so days get **lighter**, and the deterministic packing means if you'd been on quarterly before, you land back on (very nearly) the same layout you had.


### 🧑 User

make sure even if packing is deterministic that it won't be exactly the same from month to month


**🤖 Claude:**

This is a sharp catch, and it exposes a real subtlety in how the LPT bin-packer actually behaves. Let me give you the honest picture, then write the guarantee into the plan.

**What the seed does and doesn't vary.** The packer sorts highlights descending by score (character count), then greedily drops each onto the lightest day. Run that on the same library with two different seeds and:

- The **day** each highlight lands on **rotates** ✓
- The **order within a day** **rotates** ✓ (the per-bucket reshuffle)
- But **which highlights cluster together** is driven by *scores*, not the seed — so with distinct scores those groupings are largely seed-invariant.

So "not exactly the same month to month" is satisfied (days + order rotate), but the *groupings* can recur. Two things make this safe to rely on:

**1. The seed is provably distinct for every cycle — no collisions, ever.** `cycleSeed = startYear*373 + startMonth*31`. Two cycles collide only if `373·Δyear = 31·Δmonth`; since `startMonth ∈ 1..12`, `|31·Δmonth| ≤ 341 < 373`, so the only solution is the same cycle. Consecutive cycles therefore never reuse a packing → never byte-identical.

**2. This is *exactly* today's monthly behavior**, which §8 invariant #3 forces us to preserve byte-for-byte. So we can't add grouping-level variation here without breaking the "ships dark, monthly users unaffected" guarantee — that would be a separate, deliberate packer change (seed-derived score jitter) applied to freq=1 too, with its own regression baseline.

Let me add this as a design decision and a test, and note it coexists with the D7 round-trip property (same cycle = same seed = restore; different cycle = different seed = fresh).


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Now reinforce the point at the `cycleSeed` definition (§4) and add a test-matrix row:


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

The plan now guarantees cross-cycle freshness explicitly. Summary of what I added:

**New D8 (§2)** — "Consecutive cycles are never identical":
- **Proof that `cycleSeed` is collision-free** over the whole 1–12 range: `373·Δyear = 31·Δmonth` has no solution for `Δmonth ∈ ±11` except the same cycle, so every cycle gets a unique seed → consecutive cycles never reuse a packing.
- Because the seed drives both the pre-pack shuffle and the per-day reshuffle, **the day each highlight lands on and its within-day order rotate every cycle** — never byte-identical.
- An honest **caveat**: groupings (which highlights share a day) are score-driven, so they can recur on different days. That's identical to today's monthly behavior and is locked in by invariant #3, so we don't touch it. True grouping-level reshuffle (seed-derived score jitter) is **flagged as a separate decision, not adopted**, because it would change freq=1 output and need its own baseline.
- Noted that D8 and D7 are **one mechanism**: same cycle key → same seed → round-trip restore; different cycle → different seed → fresh layout.

**§4** — strengthened the `cycleSeed` note to state it's both injective (fresh neighbors) and stable (round-trip restore), with an explicit "don't replace with a constant or time-based seed."

**§10** — added a test asserting consecutive cycles are not byte-identical and that `cycleSeed` is injective across a wide span.

The one thing I want to make sure you saw, since it's the part that *isn't* fully solved: with a small, stable library you'll get different days and order each cycle, but the same highlights may keep clustering together. Fixing that (so the actual pairings shuffle too) is the score-jitter change I flagged — it's a one-liner in the packer, but it breaks the byte-identical-monthly guarantee, so I left it as an explicit decision for you rather than folding it in. Want me to spec that as an opt-in, or leave it flagged?


### 🧑 User

i think just emulate the current behavior so if we dont have that right now don't add it


**🤖 Claude:**

That's already the plan's stance — D8 keeps the packer byte-identical to today and the jitter idea is "flagged, not adopted." I'll just lock it into the §11 out-of-scope list so no future implementer mistakes it for a TODO.


**🤖 Claude:**

> 🔧 `Edit` /Users/joseph/Desktop/ProgrammingMisc/freedwise-prod/REVIEW_FREQUENCY_PLAN.md


**🤖 Claude:**

Locked in. The plan now consistently emulates current behavior — no jitter, no grouping reshuffle:

- **D8** keeps the packer byte-identical to today (days + intra-day order rotate, groupings stay score-driven).
- **§8 invariant #3** continues to require freq=1 to match the current packer exactly.
- **§11 out-of-scope** now explicitly forbids adding the grouping-level reshuffle as part of this feature.

So the only "freshness" the feature ships is whatever the current code already produces — nothing new added.
