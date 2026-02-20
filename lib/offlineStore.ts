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

export type OfflineActionType = 'rate-review' | 'rate-daily'

export interface OfflineAction {
  id?: number // auto-incremented by IndexedDB
  type: OfflineActionType
  params: any
  createdAt: number
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

/** Add an action to the offline queue */
export async function enqueueOfflineAction(action: Omit<OfflineAction, 'id' | 'createdAt'>): Promise<number> {
  return idbAdd(QUEUE_STORE, { ...action, createdAt: Date.now() })
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

/** Clear the entire offline queue */
export async function clearOfflineQueue(): Promise<void> {
  await idbClearStore(QUEUE_STORE)
}

/** Check if there are any pending actions */
export async function hasPendingActions(): Promise<boolean> {
  const actions = await idbGetAll(QUEUE_STORE)
  return actions.length > 0
}
