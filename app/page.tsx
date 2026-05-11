'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import RichTextEditor from '@/components/RichTextEditor'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import { callRedistribute } from '@/lib/redistribute'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { splitHtmlByBlankLines } from '@/lib/splitHighlightText'

export default function Home() {
  const [text, setText] = useState('')
  const [htmlContent, setHtmlContent] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [categories, setCategories] = useState<any[]>([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showCategoryInput, setShowCategoryInput] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const supabase = createClient()

  // Lock background scroll + handle Esc while fullscreen
  useEffect(() => {
    if (!fullscreen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [fullscreen])

  const hasUnsavedChanges = text.trim() !== ''
  useUnsavedChanges(hasUnsavedChanges)

  const loadCategories = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .eq('user_id', user.id)
        .order('name')

      if (error) throw error
      setCategories(data || [])
    } catch (error) {
      console.error('Error loading categories:', error)
    }
  }, [supabase])

  useEffect(() => {
    loadCategories()
  }, [loadCategories])

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { error } = await (supabase
        .from('categories') as any)
        .insert([{ name: newCategoryName.trim(), user_id: user.id }])

      if (error) throw error
      await loadCategories()
      setNewCategoryName('')
      setShowCategoryInput(false)
    } catch (error) {
      console.error('Error creating category:', error)
      alert('Failed to create category. Please try again.')
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim() || saving) return

    const highlightText = text.trim()
    const highlightHtml = htmlContent || null
    const selectedCats = [...selectedCategories]

    try {
      setSaving(true)
      setSaveSuccess(false)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        alert('Please log in to add highlights')
        setSaving(false)
        return
      }

      // Helper function to normalize text (strip HTML tags, trim, lowercase, normalize whitespace)
      const normalizeText = (text: string | null): string => {
        if (!text) return ''
        // Strip HTML tags first
        const plainText = text.replace(/<[^>]*>/g, '')
        // Trim, lowercase, and normalize whitespace
        return plainText.trim().toLowerCase().replace(/\s+/g, ' ')
      }

      // Split a single submission into multiple highlights on blank-line separators
      // (mirrors the Notion import behavior). Single-paragraph submissions return
      // a one-entry array, so the rest of the flow is uniform.
      const pieces = splitHtmlByBlankLines(highlightHtml, highlightText)
      if (pieces.length === 0) {
        setSaving(false)
        return
      }

      // Fetch existing highlights once for dedup. Only `text` — html_content
      // can be huge per row and isn't needed once text is normalized.
      const { data: existingHighlights, error: checkError } = await (supabase
        .from('highlights') as any)
        .select('id, text')
        .eq('user_id', user.id)
      if (checkError) console.error('Error checking for duplicates:', checkError)

      // Build a Set of normalized existing texts for O(1) lookup
      const existingSet = new Set<string>()
      for (const h of (existingHighlights || [])) {
        const n = normalizeText((h as { text: string }).text)
        if (n) existingSet.add(n)
      }

      // Dedup pieces against existing highlights AND against each other
      const seen = new Set<string>()
      const toInsert: { text: string; html: string }[] = []
      let droppedDupes = 0
      for (const p of pieces) {
        const nt = normalizeText(p.text)
        if (!nt) continue
        if (seen.has(nt) || existingSet.has(nt)) { droppedDupes++; continue }
        seen.add(nt)
        toInsert.push(p)
      }

      if (toInsert.length === 0) {
        setSaving(false)
        alert(pieces.length === 1 ? 'Error: Highlight already added.' : 'All highlights were duplicates.')
        return
      }

      // Clear form immediately for better UX
      setText('')
      setHtmlContent('')
      setSelectedCategories([])

      // Build rows with client-side IDs so Notion sync can proceed even if the
      // select after insert fails due to a mid-request session refresh across tabs.
      const rows = toInsert.map((p) => ({
        id: crypto.randomUUID(),
        text: p.text,
        html_content: p.html || null,
        resurface_count: 0,
        average_rating: 0,
        rating_count: 0,
        user_id: user.id,
      }))

      const { error } = await (supabase.from('highlights') as any).insert(rows)
      if (error) throw error

      // Add categories in background (non-blocking)
      if (selectedCats.length > 0) {
        const categoryLinks = rows.flatMap((r) =>
          selectedCats.map((catId) => ({ highlight_id: r.id, category_id: catId }))
        )
        ;(supabase.from('highlight_categories') as any).insert(categoryLinks).catch((err: any) => {
          console.error('Error adding categories:', err)
        })
      }

      // Queue each new highlight for Notion, then trigger sync directly so we
      // don't wait the helper's 2s debounce.
      const queuePromises = rows.map((r) =>
        addToNotionSyncQueue({
          highlightId: r.id,
          operationType: 'add',
          text: r.text,
          htmlContent: r.html_content,
        }).catch(() => {})
      )
      Promise.all(queuePromises).then(() => {
        fetch('/api/notion/sync', { method: 'POST' }).catch(() => {})
      })

      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)

      // Redistribute in the background so the UI doesn't block on a slow API
      callRedistribute(rows.map((r) => r.id)).catch(() => {})
      if (droppedDupes > 0) {
        // Best-effort notice when some — but not all — pieces were skipped
        console.warn(`Skipped ${droppedDupes} duplicate highlight(s) during bulk insert`)
      }
    } catch (error) {
      console.error('Error adding highlight:', error)
      // Restore form on error
      setText(highlightText)
      setHtmlContent(highlightHtml || '')
      setSelectedCategories(selectedCats)
      alert('Failed to add highlight. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="min-h-screen" style={{ background: 'var(--background)' }}>
      <div className="container mx-auto px-4 py-8 sm:py-12">
        <div className="max-w-3xl mx-auto">
          {/* Subtitle */}
          <div className="mb-8 sm:mb-10">
            <p className="text-lg sm:text-xl font-light" style={{ color: 'var(--text-secondary)' }}>
              Resurface your highlights in daily summaries
            </p>
          </div>

          {/* Quick Add — Typeform-style open form */}
          <form
            onSubmit={handleSubmit}
            className={fullscreen ? 'fixed inset-0 z-50 flex flex-col p-4 sm:p-6 bg-white dark:bg-gray-900 fullscreen-zoom-in' : 'mb-14 sm:mb-16'}
          >
            <div className={fullscreen ? 'flex-1 flex flex-col min-h-0 p-4 sm:p-6' : 'glass-card p-6 sm:p-8'}>
              <RichTextEditor
                value={text}
                htmlValue={htmlContent}
                onChange={(newText, newHtml) => {
                  setText(newText)
                  setHtmlContent(newHtml)
                }}
                placeholder="What do you want to remember?"
                fullscreen={fullscreen}
                onToggleFullscreen={() => setFullscreen((v) => !v)}
              />

              <div className={`flex flex-col sm:flex-row sm:items-center gap-3 ${fullscreen ? 'mt-4' : 'mt-6'}`}>
                <div className="flex-1 flex flex-wrap gap-2">
                  {categories.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => {
                        if (selectedCategories.includes(cat.id)) {
                          setSelectedCategories(selectedCategories.filter((id) => id !== cat.id))
                        } else {
                          setSelectedCategories([...selectedCategories, cat.id])
                        }
                      }}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                        selectedCategories.includes(cat.id)
                          ? 'bg-indigo-500 text-white shadow-sm'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}
                      style={!selectedCategories.includes(cat.id) ? { 
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border)'
                      } : undefined}
                    >
                      {cat.name}
                    </button>
                  ))}
                  {!showCategoryInput ? (
                    <button
                      type="button"
                      onClick={() => setShowCategoryInput(true)}
                      className="px-3 py-1.5 rounded-full text-sm transition-colors"
                      style={{ color: 'var(--text-tertiary)', border: '1px dashed var(--border)' }}
                    >
                      + Category
                    </button>
                  ) : (
                    <div className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleCreateCategory()
                          }
                        }}
                        className="input-inline-elegant"
                        placeholder="New category"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={handleCreateCategory}
                        className="btn-primary text-xs !py-1.5 !px-3"
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowCategoryInput(false)
                          setNewCategoryName('')
                        }}
                        className="btn-ghost text-xs"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!text.trim() || saving}
                  className="btn-primary w-full sm:w-auto !px-8 !py-3"
                >
                  {saving ? (
                    <>
                      <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span>Saving…</span>
                    </>
                  ) : saveSuccess ? (
                    <>
                      <svg className="h-4 w-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span>Saved!</span>
                    </>
                  ) : (
                    <span>Save Highlight</span>
                  )}
                </button>
              </div>
            </div>
          </form>
          
          {/* Navigation Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Link
              href="/highlights"
              className="glass-card glass-card-interactive p-5 flex items-center gap-4 group"
            >
              <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center group-hover:bg-indigo-100 dark:group-hover:bg-indigo-500/20 transition-colors">
                <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Highlights</h2>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Manage your highlights</p>
              </div>
            </Link>
            
            <Link
              href="/search"
              className="glass-card glass-card-interactive p-5 flex items-center gap-4 group"
            >
              <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center group-hover:bg-emerald-100 dark:group-hover:bg-emerald-500/20 transition-colors">
                <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Search</h2>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Find highlights</p>
              </div>
            </Link>
            
            <Link
              href="/daily"
              className="glass-card glass-card-interactive p-5 flex items-center gap-4 group"
            >
              <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center group-hover:bg-violet-100 dark:group-hover:bg-violet-500/20 transition-colors">
                <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Daily Review</h2>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Review highlights</p>
              </div>
            </Link>
            
            <Link
              href="/archives"
              className="glass-card glass-card-interactive p-5 flex items-center gap-4 group"
            >
              <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center group-hover:bg-amber-100 dark:group-hover:bg-amber-500/20 transition-colors">
                <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Archives</h2>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Archived highlights</p>
              </div>
            </Link>
            
            <Link
              href="/pins"
              className="glass-card glass-card-interactive p-5 flex items-center gap-4 group"
            >
              <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-rose-50 dark:bg-rose-500/10 flex items-center justify-center group-hover:bg-rose-100 dark:group-hover:bg-rose-500/20 transition-colors">
                <svg className="w-5 h-5 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Pin Board</h2>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Your pinned highlights</p>
              </div>
            </Link>
          </div>
        </div>
      </div>
    </main>
  )
}
