'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import RichTextEditor from '@/components/RichTextEditor'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'
import { callRedistribute } from '@/lib/redistribute'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

export default function Home() {
  const [text, setText] = useState('')
  const [htmlContent, setHtmlContent] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [categories, setCategories] = useState<any[]>([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showCategoryInput, setShowCategoryInput] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const supabase = createClient()

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

      // Check for duplicate highlights
      const { data: existingHighlights, error: checkError } = await (supabase
        .from('highlights') as any)
        .select('id, text, html_content')
        .eq('user_id', user.id)

      if (checkError) {
        console.error('Error checking for duplicates:', checkError)
      } else if (existingHighlights && existingHighlights.length > 0) {
        // Normalize the new highlight's text and HTML
        const normalizedText = normalizeText(highlightText)
        const normalizedHtml = normalizeText(highlightHtml)
        
        // Check if any existing highlight has the same normalized text or html_content
        const isDuplicate = existingHighlights.some((h: any) => {
          const existingText = normalizeText(h.text)
          const existingHtml = normalizeText(h.html_content)
          // Check if normalized text matches, or if normalized HTML matches
          return (normalizedText && (normalizedText === existingText || normalizedText === existingHtml)) ||
                 (normalizedHtml && (normalizedHtml === existingText || normalizedHtml === existingHtml))
        })
        
        if (isDuplicate) {
          setSaving(false)
          alert('Error: Highlight already added.')
          return
        }
      }

      // Clear form immediately for better UX
      setText('')
      setHtmlContent('')
      setSelectedCategories([])

      // Generate ID client-side so Notion sync can proceed even if the select
      // after insert fails due to a mid-request session refresh across tabs
      const newHighlightId = crypto.randomUUID()

      // Save to database
      const { error } = await (supabase
        .from('highlights') as any)
        .insert([
          {
            id: newHighlightId,
            text: highlightText,
            html_content: highlightHtml,
            resurface_count: 0,
            average_rating: 0,
            rating_count: 0,
            user_id: user.id,
          },
        ])

      if (error) throw error

      // Add categories in background (non-blocking)
      if (selectedCats.length > 0) {
        const categoryLinks = selectedCats.map((catId) => ({
          highlight_id: newHighlightId,
          category_id: catId,
        }))
        ;(supabase.from('highlight_categories') as any).insert(categoryLinks).catch((err: any) => {
          console.error('Error adding categories:', err)
        })
      }

      // Add to Notion sync queue via deduplicating API (non-blocking)
      addToNotionSyncQueue({
        highlightId: newHighlightId,
        operationType: 'add',
        text: highlightText,
        htmlContent: highlightHtml,
      }).catch(() => {})

      // Redistribute: place only this new highlight on a remaining day
      await callRedistribute([newHighlightId])

      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
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
      <div className="container mx-auto px-4 py-10 sm:py-16">
        <div className="max-w-3xl mx-auto">
          {/* Hero */}
          <div className="mb-10 sm:mb-14">
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-3" style={{ color: 'var(--text-primary)' }}>
              Freedwise
            </h1>
            <p className="text-lg sm:text-xl font-light" style={{ color: 'var(--text-secondary)' }}>
              Resurface your highlights in daily summaries
            </p>
          </div>

          {/* Quick Add — Typeform-style open form */}
          <form onSubmit={handleSubmit} className="mb-14 sm:mb-16">
            <div className="glass-card p-6 sm:p-8">
              <RichTextEditor
                value={text}
                htmlValue={htmlContent}
                onChange={(newText, newHtml) => {
                  setText(newText)
                  setHtmlContent(newHtml)
                }}
                placeholder="What do you want to remember?"
              />
              
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-6">
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
