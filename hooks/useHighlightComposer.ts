'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { splitHtmlByBlankLines } from '@/lib/splitHighlightText'
import { saveHighlights, type NewHighlightRow } from '@/lib/saveHighlights'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import { callRedistribute } from '@/lib/redistribute'
import { highlightDraftPrefix, readHighlightDrafts, type HighlightDraft as Draft, type StoredHighlightDraft } from '@/lib/highlightDrafts'

const emptyDraft = (): Draft => ({ text: '', html: '', categories: [] })

export function useHighlightComposer(scope: 'home' | 'highlights') {
  const supabase = createClient()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const current = useRef(draft)
  const owner = useRef<string | null>(null)
  const key = useRef<string | null>(null)
  const lastStored = useRef<string | null>(null)
  const recoveredSource = useRef<StoredHighlightDraft | null>(null)
  const busy = useRef(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<string | null>(null)
  const [otherDrafts, setOtherDrafts] = useState<StoredHighlightDraft[]>([])

  const refreshOtherDrafts = () => {
    try {
      setOtherDrafts(owner.current
        ? readHighlightDrafts(highlightDraftPrefix(owner.current, scope)).filter((d) => d.key !== key.current)
        : [])
    } catch { /* The backup warning below covers unavailable storage. */ }
  }

  const persist = (next: Draft) => {
    if (!key.current) return false
    try {
      if (next.text.trim()) {
        const serialized = JSON.stringify({ ...next, updatedAt: Date.now() })
        window.localStorage.setItem(key.current, serialized)
        lastStored.current = serialized
        // Each mounted editor owns a separate backup. Transfer a recovered
        // record only AFTER its replacement is durable, so two tabs can edit
        // independently without overwriting each other's drafts.
        const source = recoveredSource.current
        if (source && window.localStorage.getItem(source.key) === source.raw) {
          window.localStorage.removeItem(source.key)
        }
        recoveredSource.current = null
        setDraftStatus('Draft backed up on this device. Save to add it to your library.')
      } else {
        // A completed save in this tab must not erase another tab's newer draft.
        if (window.localStorage.getItem(key.current) === lastStored.current) {
          window.localStorage.removeItem(key.current)
        }
        lastStored.current = null
        setDraftStatus(null)
      }
      refreshOtherDrafts()
      return true
    } catch {
      setDraftStatus('Device backup unavailable. Keep this page open until your save is confirmed.')
      return false
    }
  }
  const replace = (next: Draft) => {
    current.current = next
    // Synchronous, on every change: mobile OS termination need not fire unload.
    persist(next)
    setDraft(next)
  }

  useEffect(() => {
    let active = true
    let authChanged = false
    const restore = (userId: string | null) => {
      if (!active || (owner.current === userId && key.current)) return
      owner.current = userId
      key.current = userId ? `${highlightDraftPrefix(userId, scope)}${crypto.randomUUID()}` : null
      lastStored.current = null
      recoveredSource.current = null
      let next = emptyDraft()
      setDraftStatus(userId ? null : 'Sign in to recover your drafts and save highlights.')
      setSaveSuccess(false)
      setError(null)
      setNotice(null)
      if (key.current) {
        try {
          const saved = readHighlightDrafts(highlightDraftPrefix(userId!, scope))[0]
          if (saved) {
            next = saved.draft
            recoveredSource.current = saved
            persist(next)
            // A failed copy must keep its backup-unavailable warning.
            if (lastStored.current) setDraftStatus('Recovered your draft from this device. Save to add it to your library.')
          }
        } catch {
          setDraftStatus('Could not recover the device backup. Keep this page open until your save is confirmed.')
        }
      }
      current.current = next
      setDraft(next)
      setReady(!!userId)
      refreshOtherDrafts()
    }
    // Use the session owner without adding a getUser verification request.
    // Supabase may still refresh an expired session; RLS authorizes the write.
    const init = async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!authChanged) restore(data.session?.user.id ?? null)
      } catch {
        try {
          const { data } = await supabase.auth.getUser()
          if (!authChanged) restore(data.user?.id ?? null)
        } catch {
          if (!authChanged) restore(null)
        }
      }
    }
    const subscription = supabase.auth.onAuthStateChange?.((_event, session) => {
      authChanged = true
      restore(session?.user.id ?? null)
    }).data.subscription
    void init()
    window.addEventListener('storage', refreshOtherDrafts)
    window.addEventListener('focus', refreshOtherDrafts)
    return () => {
      active = false
      subscription?.unsubscribe()
      window.removeEventListener('storage', refreshOtherDrafts)
      window.removeEventListener('focus', refreshOtherDrafts)
    }
    // These helpers use refs for the current owner/key; subscribe once per client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, scope])

  const recoverDraft = (draftKey: string) => {
    if (busy.current || !owner.current) return
    if (current.current.text.trim() && !persist(current.current)) {
      setError('Could not back up your current draft. Save it before switching drafts.')
      return
    }
    try {
      const prefix = highlightDraftPrefix(owner.current, scope)
      const saved = readHighlightDrafts(prefix).find((d) => d.key === draftKey)
      if (!saved || saved.key === key.current) return
      key.current = `${prefix}${crypto.randomUUID()}`
      lastStored.current = null
      recoveredSource.current = saved
      replace(saved.draft)
      setSaveSuccess(false)
      setError(null)
      setNotice(null)
    } catch {
      setError('Could not recover that draft. Your current draft has been kept.')
    }
  }

  const changeContent = (text: string, html: string) => {
    if (busy.current || !ready) return
    const prev = current.current
    if (text === prev.text && html === prev.html) return
    replace({ text, html, categories: prev.categories })
    setSaveSuccess(false)
    setNotice(null)
    setError(null)
  }
  const setSelectedCategories = (categories: string[]) => {
    if (busy.current || !ready) return
    replace({ ...current.current, categories })
  }
  const clear = () => replace(emptyDraft())
  const completeExternalSave = () => {
    // A delayed fold response belongs to the draft/account that initiated it.
    if (current.current !== draft) return false
    clear()
    setSaveSuccess(true)
    return true
  }

  const submit = async (onSaved?: (rows: NewHighlightRow[]) => void) => {
    if (busy.current || !ready || !current.current.text.trim()) return
    busy.current = true
    setSaving(true)
    setSaveSuccess(false)
    setNotice(null)
    setError(null)
    const userId = owner.current
    try {
      if (!userId) throw new Error('Please sign in to save your highlight. Your text is still in the editor.')
      const snapshot = current.current
      const pieces = splitHtmlByBlankLines(snapshot.html, snapshot.text)
      if (!pieces.length) throw new Error('No highlight text to save. Your draft has been kept.')
      const ids = snapshot.ids?.length === pieces.length ? snapshot.ids : pieces.map(() => crypto.randomUUID())
      const createdAt = snapshot.createdAt || new Date().toISOString()
      const attempt = { ...snapshot, ids, createdAt }
      replace(attempt)
      const rows: NewHighlightRow[] = pieces.map((p, i) => ({
        id: ids[i], user_id: userId, text: p.text, html_content: p.html || null,
        archived: false, created_at: createdAt, resurface_count: 0, average_rating: 0, rating_count: 0,
      }))
      const { savedRows, duplicateCount } = await saveHighlights(supabase, rows, snapshot.categories)
      // An account transition must not clear or modify the new account's form.
      if (owner.current !== userId || current.current !== attempt) return
      clear()
      setSaveSuccess(savedRows.length > 0)
      if (duplicateCount) setNotice(`${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'} skipped — already in your library, possibly archived.`)
      for (const row of savedRows) {
        void addToNotionSyncQueue({ highlightId: row.id, operationType: 'add' }).catch(() => {})
      }
      if (savedRows.length) void callRedistribute(savedRows.map((r) => r.id)).catch(() => {})
      onSaved?.(savedRows)
    } catch (err) {
      console.error('Error saving highlights:', err)
      if (owner.current === userId) setError(
        err instanceof Error && (err.message.startsWith('Please sign in') || err.message.startsWith('Highlight text is saved'))
          ? err.message
          : 'Save not confirmed. Your draft has been kept. Check your connection and retry; retrying is safe.'
      )
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  return {
    text: draft.text, htmlContent: draft.html, selectedCategories: draft.categories,
    changeContent, setSelectedCategories, completeExternalSave, submit, ready, saving, saveSuccess,
    notice, error, draftStatus,
    otherDrafts: otherDrafts.map((d) => ({ key: d.key, text: d.draft.text })), recoverDraft,
  }
}
