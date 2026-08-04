/**
 * Regression test for the offline rating lag.
 *
 * enqueueOfflineAction used to stamp the queued action's owner by awaiting
 * supabase.auth.getSession(). Despite the name that is not a local read: when
 * the access token is at or near expiry, auth-js kicks off a token refresh and
 * retries it with exponential backoff for up to a full auto-refresh tick (~30s)
 * while holding the auth lock. Offline that refresh can never succeed, so the
 * first rating after going offline sat behind the whole backoff with its
 * buttons disabled — the app looked like it was "still trying to save".
 *
 * The owner id now comes from rememberUserId() (primed by <OfflineSync>'s auth
 * listener), so the queue write touches no auth API at all. These tests model
 * the offline case as a getSession() that never settles: if anything on the
 * enqueue path awaits it, they hang instead of passing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  // Never settles — exactly how an offline token refresh behaves for the
  // duration of its backoff.
  getSession: vi.fn(() => new Promise(() => {})),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: authMocks }),
}))

/**
 * Minimal in-memory stand-in for the IndexedDB surface lib/offlineStore uses:
 * open → db.transaction(store).objectStore(store) → get/put/add/getAll/delete/clear.
 * Requests settle on a macrotask, like the real thing.
 */
function installIndexedDBStub() {
  const stores: Record<string, Map<any, any>> = {
    highlightCache: new Map(),
    offlineQueue: new Map(),
  }
  let autoId = 0

  const settle = (req: any, result: any) => {
    setTimeout(() => {
      req.result = result
      req.onsuccess?.()
    }, 0)
    return req
  }

  const objectStore = (name: string) => ({
    get: (key: any) => settle({} as any, stores[name].get(key)),
    put: (value: any) => {
      const key = value.key ?? value.id
      stores[name].set(key, value)
      return settle({} as any, key)
    },
    add: (value: any) => {
      const id = ++autoId
      stores[name].set(id, { ...value, id })
      return settle({} as any, id)
    },
    getAll: () => settle({} as any, [...stores[name].values()]),
    delete: (key: any) => {
      stores[name].delete(key)
      return settle({} as any, undefined)
    },
    clear: () => {
      stores[name].clear()
      return settle({} as any, undefined)
    },
  })

  const db: any = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore }),
    close: () => {},
  }

  ;(globalThis as any).indexedDB = { open: () => settle({} as any, db) }
  return stores
}

let stores: Record<string, Map<any, any>>

beforeEach(() => {
  // Fresh module state: the DB handle, the write chain and the remembered owner
  // id are all module-level.
  vi.resetModules()
  authMocks.getSession.mockClear()
  window.localStorage.clear()
  stores = installIndexedDBStub()
})

describe('enqueueOfflineAction — never waits on auth', () => {
  it('stamps the owner from the remembered id without calling getSession', async () => {
    const { enqueueOfflineAction, rememberUserId } = await import('@/lib/offlineStore')
    rememberUserId('u1')

    // Would hang here if the owner stamp still awaited getSession().
    const id = await enqueueOfflineAction({
      type: 'rate-review',
      params: { rating: 'high' },
    })

    expect(authMocks.getSession).not.toHaveBeenCalled()
    expect(stores.offlineQueue.get(id)).toMatchObject({ type: 'rate-review', userId: 'u1' })
  })

  it('reads the remembered id back from localStorage across a page load', async () => {
    const first = await import('@/lib/offlineStore')
    first.rememberUserId('u1')

    // Simulate navigating to another page: module state is gone, localStorage isn't.
    vi.resetModules()
    const { enqueueOfflineAction } = await import('@/lib/offlineStore')

    const id = await enqueueOfflineAction({ type: 'rate-daily', params: {} })

    expect(authMocks.getSession).not.toHaveBeenCalled()
    expect(stores.offlineQueue.get(id)).toMatchObject({ userId: 'u1' })
  })

  it('still queues immediately when no owner id is known, stamping it later', async () => {
    const { enqueueOfflineAction } = await import('@/lib/offlineStore')

    // Nothing primed and no stored id: the action must still land right away,
    // unstamped (replay treats that as the current user's, as it always has),
    // with the owner resolved in the background rather than awaited.
    const id = await enqueueOfflineAction({ type: 'rate-review', params: {} })

    expect(stores.offlineQueue.get(id)).toMatchObject({ type: 'rate-review' })
    expect(stores.offlineQueue.get(id).userId).toBeUndefined()
    expect(authMocks.getSession).toHaveBeenCalled() // background, not awaited
  })

  it('clears the remembered id on sign-out so the next account cannot inherit it', async () => {
    const { rememberUserId, clearAllOfflineData, enqueueOfflineAction } = await import(
      '@/lib/offlineStore'
    )
    rememberUserId('u1')
    await clearAllOfflineData()

    const id = await enqueueOfflineAction({ type: 'rate-review', params: {} })
    expect(stores.offlineQueue.get(id).userId).toBeUndefined()
  })
})

describe('offlineStore — connection reuse', () => {
  it('opens the IndexedDB connection once across operations, not once per call', async () => {
    const { enqueueOfflineAction, getPendingActions, rememberUserId } = await import(
      '@/lib/offlineStore'
    )
    rememberUserId('u1')

    const openSpy = vi.spyOn((globalThis as any).indexedDB, 'open')
    await enqueueOfflineAction({ type: 'rate-review', params: {} })
    await enqueueOfflineAction({ type: 'rate-review', params: {} })
    await getPendingActions()

    // Every rating used to reopen the database 2-3 times; now the memoized
    // connection serves all of them.
    expect(openSpy).toHaveBeenCalledTimes(1)
  })
})
