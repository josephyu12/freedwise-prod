'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

const UNSAVED_MESSAGE = 'You have unsaved changes. Are you sure you want to leave?'

/**
 * Registers beforeunload and blocks in-app navigation when there are unsaved changes
 * in a highlight entry/edit block. Call with hasUnsavedChanges true when the user
 * has typed in a highlight field and not yet saved.
 */
export function useUnsavedChanges(hasUnsavedChanges: boolean) {
  const router = useRouter()

  // Browser refresh/close/navigate to external site
  useEffect(() => {
    if (!hasUnsavedChanges) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Modern browsers show a generic message; this is required to trigger the dialog
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedChanges])

  // In-app navigation: intercept internal link clicks
  useEffect(() => {
    if (!hasUnsavedChanges) return
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element).closest('a')
      if (!a?.href || a.target === '_blank' || a.hasAttribute('download')) return
      try {
        const url = new URL(a.href)
        if (url.origin !== window.location.origin) return
        if (url.pathname === window.location.pathname && url.search === window.location.search) return
        e.preventDefault()
        if (window.confirm(UNSAVED_MESSAGE)) {
          router.push(url.pathname + url.search + url.hash)
        }
      } catch {
        // ignore invalid URLs
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [hasUnsavedChanges, router])
}
