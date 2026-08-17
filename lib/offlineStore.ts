/**
 * IndexedDB-based offline storage for highlight review.
 *
 * Two stores:
 *   1. highlightCache – caches fetched highlights per date (and a special "review" key)
 *   2. offlineQueue  – ordered queue of write actions to replay when back online
 */

import { createClient } from './supabase/client'

const DB_NAME = 'freedwise-offline'
const DB_VERSION = 1
const CACHE_STORE = 'highlightCache'
const QUEUE_STORE = 'offlineQueue'

// ─── Types ──────────────────────────────────────────────────

export interface CachedDailyData {
  date: string
  summary: any // DailySummary-shaped object
  categories: any[]
  pinnedHighlightIds: string[]
  monthReviewStatus?: Record<string, string>
  monthsWithAssignments?: string[]
  cachedAt: number
}

export interface CachedReviewData {
  key: 'review' // constant key
  highlights: any[] // ReviewHighlight[]
  categories: any[]
  pinnedHighlightIds: string[]
  cachedAt: number
}

export type OfflineActionType =
  | 'rate-review'
  | 'rate-daily'
  | 'update-highlight-stats'
  | 'edit-highlight'
  | 'split-highlight'
  | 'archive-highlight'
  | 'unarchive-highlight'
  | 'delete-highlight'
  | 'pin-highlight'
  | 'unpin-highlight'

export interface OfflineAction {
  id?: number // auto-incremented by IndexedDB
  type: OfflineActionType
  params: any
  createdAt: number
  attempts?: number // failed replay attempts; used to drop poison actions
  // Owner stamped at enqueue time. Replay only runs actions whose owner is the
  // signed-in user (unstamped = legacy, treated as the current user's), so a
  // session/account switch can never replay one account's writes under another.
  userId?: string
}

// ─── DB Helpers ─────────────────────────────────────────────

// One connection per page load instead of one per operation. Every rating
// touches the DB 2-3 times (cache read, cache write, queue add); reopening the
// database each time added avoidable latency to a path the user is waiting on.
let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // A closed/versionchanged connection can't serve transactions; drop the
      // memo so the next call opens a fresh one.
      db.onclose = () => {
        dbPromise = null
      }
      db.onversionchange = () => {
        dbPromise = null
        db.close()
      }
      resolve(db)
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  }).catch((err) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => reject(req.error)
      })
  )
}

function idbPut(storeName: string, value: any): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.put(value)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
  )
}

function idbAdd(storeName: string, value: any): Promise<number> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.add(value)
        req.onsuccess = () => resolve(req.result as number)
        req.onerror = () => reject(req.error)
      })
  )
}

function idbGetAll<T>(storeName: string): Promise<T[]> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result as T[])
        req.onerror = () => reject(req.error)
      })
  )
}

function idbClearStore(storeName: string): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
  )
}

function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.delete(key)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
  )
}

// ─── Highlight Cache ────────────────────────────────────────

/** Cache daily page data for a specific date */
export async function cacheDailyData(data: CachedDailyData): Promise<void> {
  await idbPut(CACHE_STORE, { key: `daily-${data.date}`, ...data })
}

/** Get cached daily page data for a specific date */
export async function getCachedDailyData(date: string): Promise<CachedDailyData | undefined> {
  return idbGet<CachedDailyData>(CACHE_STORE, `daily-${date}`)
}

/** Cache review page data (today's highlights in review format) */
export async function cacheReviewData(data: Omit<CachedReviewData, 'key'>): Promise<void> {
  await idbPut(CACHE_STORE, { key: 'review', ...data })
}

/** Get cached review page data */
export async function getCachedReviewData(): Promise<CachedReviewData | undefined> {
  return idbGet<CachedReviewData>(CACHE_STORE, 'review')
}

// ─── Ahead Pre-load Cache ───────────────────────────────────
//
// Pre-loaded review-ahead data, written in the background while the user is
// still on the normal /review page. Stored under a separate key so the normal
// review cache isn't bloated or overwritten. Read when opening ?ahead=1 while
// offline to provide a seamless transition.

export interface CachedReviewAheadData {
  key: 'review-ahead'
  highlights: any[] // ReviewHighlight[] — full [today + catchUp + ahead] array
  categories: any[]
  pinnedHighlightIds: string[]
  // The "today" (yyyy-MM-dd) the snapshot was built around. The today/catch-up/
  // ahead split is only valid for that day — a snapshot from yesterday would
  // misclassify rows, so readers treat a mismatched day as stale. Optional only
  // because entries written before this field existed lack it.
  today?: string
  cachedAt: number
}

/** Cache pre-loaded review-ahead data (background pre-fetch). */
export async function cacheReviewAheadData(data: Omit<CachedReviewAheadData, 'key'>): Promise<void> {
  await idbPut(CACHE_STORE, { key: 'review-ahead', ...data })
}

/** Get pre-loaded review-ahead data (written by the background pre-fetcher). */
export async function getCachedReviewAheadData(): Promise<CachedReviewAheadData | undefined> {
  return idbGet<CachedReviewAheadData>(CACHE_STORE, 'review-ahead')
}

/**
 * Whether an ahead snapshot is usable for the given day. Entries from before
 * the `today` stamp existed fall back to the day the entry was written.
 */
export function isReviewAheadCacheFresh(
  cached: CachedReviewAheadData | undefined,
  today: string
): boolean {
  if (!cached) return false
  const snapshotDay = cached.today ?? localDateString(cached.cachedAt)
  return snapshotDay === today
}

function localDateString(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

// ─── Owner Stamp ────────────────────────────────────────────
//
// The signed-in user's id, kept where a queue write can read it with zero
// awaits. Primed by <OfflineSync>'s onAuthStateChange listener on every page
// load (and refreshed on every auth event), mirrored to localStorage so it
// survives the full-page navigations between /review and /daily.

const USER_ID_KEY = 'freedwise:offline-owner-id'
let rememberedUserId: string | null = null

/** Record (or clear, with null) the signed-in user for offline-queue stamping. */
export function rememberUserId(userId: string | null): void {
  rememberedUserId = userId
  if (typeof window === 'undefined') return
  try {
    if (userId) window.localStorage.setItem(USER_ID_KEY, userId)
    else window.localStorage.removeItem(USER_ID_KEY)
  } catch {
    // Private mode / quota — the in-memory copy still covers this page load.
  }
}

/** The remembered owner id, synchronously. Undefined if nothing primed it. */
function readRememberedUserId(): string | undefined {
  if (rememberedUserId) return rememberedUserId
  if (typeof window === 'undefined') return undefined
  try {
    const stored = window.localStorage.getItem(USER_ID_KEY)
    if (stored) {
      rememberedUserId = stored
      return stored
    }
  } catch {
    /* unreadable storage — fall through to unstamped */
  }
  return undefined
}

/** Resolve the owner off the critical path and stamp an already-queued action. */
async function stampOwnerInBackground(id: number): Promise<void> {
  try {
    const { data } = await createClient().auth.getSession()
    const userId = data?.session?.user?.id
    if (!userId) return
    rememberUserId(userId)
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, 'readwrite')
      const store = tx.objectStore(QUEUE_STORE)
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const action = getReq.result as OfflineAction | undefined
        // Already replayed and removed, or stamped by someone else — nothing to do.
        if (!action || action.userId) {
          resolve()
          return
        }
        const putReq = store.put({ ...action, userId })
        putReq.onsuccess = () => resolve()
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
  } catch {
    // Best effort: an unstamped action still replays as the current user's.
  }
}

// ─── Offline Queue ──────────────────────────────────────────
//
// NOTE: this queue is NOT durable indefinitely. iOS Safari evicts IndexedDB
// (and SW caches) for PWAs not opened in ~7 days, so unsynced offline actions
// can be dropped if the app isn't reopened within a week. Treat it as a
// best-effort buffer for short offline spells, not long-term storage.

/** Add an action to the offline queue */
export async function enqueueOfflineAction(action: Omit<OfflineAction, 'id' | 'createdAt'>): Promise<number> {
  // Stamp the owner so replay can refuse to run this under a different account.
  //
  // This deliberately does NOT call auth.getSession(). Despite the name, that is
  // not a local read: when the access token is at/near expiry it triggers a
  // token refresh, and auth-js retries that request with exponential backoff for
  // up to a full AUTO_REFRESH_TICK (~30s) while holding the auth lock. Offline,
  // the refresh can never succeed, so every enqueue behind it stalled for the
  // whole backoff — which is what made the rating buttons hang for tens of
  // seconds on the first tap after going offline. rememberUserId() (called from
  // <OfflineSync>'s auth listener) keeps the id available synchronously instead.
  const userId = action.userId ?? readRememberedUserId()
  const id = await idbAdd(QUEUE_STORE, { ...action, ...(userId ? { userId } : {}), createdAt: Date.now() })
  // No id on record yet (nothing has primed it this page load and localStorage
  // is unavailable). Resolve it in the BACKGROUND and stamp the row after the
  // fact, so the owner guarantee is preserved without the caller ever waiting.
  // Until it lands the action is unstamped, which replay treats as the current
  // user's — the same as a legacy action.
  if (!userId) void stampOwnerInBackground(id)
  // Poke the global <OfflineSync> drainer so a write that failed on a weak
  // signal (queued while still "online") gets retried promptly, instead of
  // waiting for the next offline→online transition.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('offline-action-enqueued'))
  }
  return id
}

/** Queue a retry of average_rating / rating_count / auto-archive bookkeeping.
 * Used when the rating itself already saved but the background stats write
 * died on a flaky connection — a dedicated action so a stats failure can
 * never poison-drop the rating. */
export function enqueueHighlightStatsRetry(highlightId: string, ratingDate: string) {
  return enqueueOfflineAction({
    type: 'update-highlight-stats',
    params: { highlightId, ratingDate },
  })
}

/** Get all pending offline actions in order */
export async function getPendingActions(): Promise<OfflineAction[]> {
  const actions = await idbGetAll<OfflineAction>(QUEUE_STORE)
  return actions.sort((a, b) => a.createdAt - b.createdAt)
}

/** Remove a single action from the queue by its ID */
export async function removeAction(id: number): Promise<void> {
  await idbDelete(QUEUE_STORE, id)
}

/**
 * Increment and return a queued action's failed-replay count. Lets a replayer
 * drop a permanently-failing ("poison") action after enough attempts so it
 * can't block the rest of the queue forever. Returns 0 if the action is gone.
 */
export async function incrementActionAttempts(id: number): Promise<number> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite')
    const store = tx.objectStore(QUEUE_STORE)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const action = getReq.result as OfflineAction | undefined
      if (!action) {
        resolve(0)
        return
      }
      action.attempts = (action.attempts || 0) + 1
      const putReq = store.put(action)
      putReq.onsuccess = () => resolve(action.attempts!)
      putReq.onerror = () => reject(putReq.error)
    }
    getReq.onerror = () => reject(getReq.error)
  })
}

/** Clear the entire offline queue */
export async function clearOfflineQueue(): Promise<void> {
  await idbClearStore(QUEUE_STORE)
}

/** Check if there are any pending actions */
export async function hasPendingActions(): Promise<boolean> {
  const actions = await idbGetAll(QUEUE_STORE)
  return actions.length > 0
}

/**
 * Clear ALL offline data on this device: the page-data cache and the pending
 * action queue. Call on sign-out — neither store is keyed by user, so without
 * this the next account on the device could read the previous account's cached
 * highlights offline, and the previous account's queued writes would replay
 * under the new session (where RLS makes them silently match zero rows and the
 * queue discards them as "done").
 */
export async function clearAllOfflineData(): Promise<void> {
  rememberUserId(null)
  await Promise.all([idbClearStore(CACHE_STORE), idbClearStore(QUEUE_STORE)])
}
