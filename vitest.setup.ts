import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { webcrypto } from 'node:crypto'

// The add-highlight flow calls crypto.randomUUID() for client-side row IDs.
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
}

// jsdom does not implement these; stub so handlers under test don't blow up.
if (typeof window !== 'undefined') {
  window.alert = () => {}
  window.confirm = () => true
}

afterEach(() => {
  cleanup()
})
