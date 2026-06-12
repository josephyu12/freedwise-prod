/**
 * IndexedDB-based offline storage for highlight review.
 *
 * Two stores:
 *   1. highlightCache – caches fetched highlights per date (and a special "review" key)
 *   2. offlineQueue  – ordered queue of write actions to replay when back online
 */

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
}

// ─── DB Helpers ─────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
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

// ─── Offline Queue ──────────────────────────────────────────
//
// NOTE: this queue is NOT durable indefinitely. iOS Safari evicts IndexedDB
// (and SW caches) for PWAs not opened in ~7 days, so unsynced offline actions
// can be dropped if the app isn't reopened within a week. Treat it as a
// best-effort buffer for short offline spells, not long-term storage.

/** Add an action to the offline queue */
export async function enqueueOfflineAction(action: Omit<OfflineAction, 'id' | 'createdAt'>): Promise<number> {
  const id = await idbAdd(QUEUE_STORE, { ...action, createdAt: Date.now() })
  // Poke the global <OfflineSync> drainer so a write that failed on a weak
  // signal (queued while still "online") gets retried promptly, instead of
  // waiting for the next offline→online transition.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('offline-action-enqueued'))
  }
  return id
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
