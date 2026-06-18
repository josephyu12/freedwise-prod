// The review "cycle" abstraction: a run of N calendar-aligned months that the
// user reviews their whole library across once. `frequency_months` (freq) is
// 1..12 — 1 = monthly (today's behavior), 2 = every two months, 3 = quarterly,
// … 12 = yearly. Cycles are aligned to a fixed January epoch (REVIEW_FREQUENCY_PLAN.md
// D3), so freq=1 collapses exactly onto calendar months with zero data migration.
//
// BACKWARD-COMPAT INVARIANTS (plan §8) — unit-tested in __tests__/cycle.test.ts:
//   1. getCycle(y, m, 1).key === "YYYY-MM" of that month.
//   2. getCycle(y, m, 1).dates === days 01..lastDay of that month, ascending.
//   3. cycleSeed(getCycle(y, m, 1)) === y*373 + m*31 (old bin-pack seed).
//   4. nextCycle(monthly cycle) === the next calendar month.

export interface Cycle {
  freq: number
  startYear: number
  startMonth: number // 1-12
  endYear: number
  endMonth: number // 1-12
  startDate: string // YYYY-MM-DD, first day of the cycle
  endDate: string // YYYY-MM-DD, last day of the cycle
  key: string // YYYY-MM of the start month (== month_year when freq === 1)
  dates: string[] // every YYYY-MM-DD in the cycle, ascending
}

const pad = (n: number) => String(n).padStart(2, '0')
// m is 1-12; new Date(y, m, 0) gives the last day of month m, so .getDate() == days in month
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate()
const monthIndex = (y: number, m: number) => y * 12 + (m - 1)
const fromIndex = (idx: number) => ({ year: Math.floor(idx / 12), month: (idx % 12) + 1 })

/** Clamp/normalize a raw frequency to an integer in [1, 12]. */
export function normalizeFreq(freq: number | null | undefined): number {
  const f = Math.floor(freq || 1)
  if (!Number.isFinite(f) || f < 1) return 1
  if (f > 12) return 12
  return f
}

/** The cycle that contains (year, month) for a given frequency. */
export function getCycle(year: number, month: number, freq: number): Cycle {
  const f = normalizeFreq(freq)
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
    if (cm > 12) {
      cm = 1
      cy++
    }
  }

  return {
    freq: f,
    startYear: sy,
    startMonth: sm,
    endYear: ey,
    endMonth: em,
    startDate: `${sy}-${pad(sm)}-01`,
    endDate: `${ey}-${pad(em)}-${pad(daysIn(ey, em))}`,
    key: `${sy}-${pad(sm)}`,
    dates,
  }
}

/** The cycle containing the given YYYY-MM-DD date. */
export function getCycleForDate(dateStr: string, freq: number): Cycle {
  const [y, m] = dateStr.split('-').map(Number)
  return getCycle(y, m, freq)
}

/** The cycle key (start month, YYYY-MM) for the cycle containing (year, month). */
export function cycleKey(year: number, month: number, freq: number): string {
  return getCycle(year, month, freq).key
}

/** The cycle key for the cycle containing the given YYYY-MM-DD date. */
export function cycleKeyForDate(dateStr: string, freq: number): string {
  return getCycleForDate(dateStr, freq).key
}

/** The cycle immediately after `c`. */
export function nextCycle(c: Cycle): Cycle {
  let ny = c.endYear
  let nm = c.endMonth + 1
  if (nm > 12) {
    nm = 1
    ny++
  }
  return getCycle(ny, nm, c.freq)
}

/** The cycle immediately before `c`. */
export function prevCycle(c: Cycle): Cycle {
  let py = c.startYear
  let pm = c.startMonth - 1
  if (pm < 1) {
    pm = 12
    py--
  }
  return getCycle(py, pm, c.freq)
}

/**
 * Per-cycle deterministic seed. For freq===1 this equals the old
 * `year*373 + month*31`, keeping bin-pack output identical for monthly users.
 * Injective over (startYear, startMonth) — see plan §3/D8 — so consecutive
 * cycles never reuse a seed, yet a given cycle always reproduces its layout.
 */
export function cycleSeed(c: Cycle): number {
  return c.startYear * 373 + c.startMonth * 31
}

// ─── Per-user review settings ───────────────────────────────────────────────

export interface ReviewSettings {
  freq: number // frequency_months, ≥ 1
  enabled: boolean // daily_review_enabled
}

/**
 * Read the per-user review settings. Defaults are LOAD-BEARING (plan §4): a user
 * with no `user_review_settings` row reads as { freq: 1, enabled: true } so
 * today's behavior is preserved with zero rows written. Never treat a missing
 * row (or a missing column) as "off".
 */
export async function getUserReviewSettings(
  supabase: any,
  userId: string
): Promise<ReviewSettings> {
  try {
    const { data } = await supabase
      .from('user_review_settings')
      .select('frequency_months, daily_review_enabled')
      .eq('user_id', userId)
      .maybeSingle()
    const row = data as { frequency_months?: number; daily_review_enabled?: boolean } | null
    return {
      freq: normalizeFreq(row?.frequency_months),
      enabled: row?.daily_review_enabled ?? true,
    }
  } catch {
    // If the table doesn't exist yet (migration not run) or the read fails,
    // fall back to the safe defaults so the app behaves exactly like today.
    return { freq: 1, enabled: true }
  }
}

/** Convenience: frequency only. */
export async function getUserFrequency(supabase: any, userId: string): Promise<number> {
  return (await getUserReviewSettings(supabase, userId)).freq
}

/** The set of frequencies offered in the UI: divisors of 12 (plan D6). */
export const FREQUENCY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'Monthly' },
  { value: 2, label: 'Every 2 months' },
  { value: 3, label: 'Every 3 months' },
  { value: 4, label: 'Every 4 months' },
  { value: 6, label: 'Every 6 months' },
  { value: 12, label: 'Yearly' },
]

/** Human label for a cycle, e.g. "January 2026" (freq 1) or "Jan–Mar 2026". */
export function cycleLabel(c: Cycle): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const short = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]
  if (c.freq === 1) return `${months[c.startMonth - 1]} ${c.startYear}`
  if (c.startYear === c.endYear) {
    return `${short[c.startMonth - 1]}–${short[c.endMonth - 1]} ${c.startYear}`
  }
  return `${short[c.startMonth - 1]} ${c.startYear} – ${short[c.endMonth - 1]} ${c.endYear}`
}
