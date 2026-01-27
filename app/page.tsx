'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import RichTextEditor from '@/components/RichTextEditor'
import { addToNotionSyncQueue } from '@/lib/notionSyncQueue'

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

      // Save to database
      const { data: highlightData, error } = await (supabase
        .from('highlights') as any)
        .insert([
          {
            text: highlightText,
            html_content: highlightHtml,
            resurface_count: 0,
            average_rating: 0,
            rating_count: 0,
            user_id: user.id,
          },
        ])
        .select()
        .single()

      if (error) throw error

      // Add categories in background (non-blocking)
      if (selectedCats.length > 0) {
        const categoryLinks = selectedCats.map((catId) => ({
          highlight_id: highlightData.id,
          category_id: catId,
        }))
        ;(supabase.from('highlight_categories') as any).insert(categoryLinks).catch((err: any) => {
          console.error('Error adding categories:', err)
        })
      }

      // Add to Notion sync queue via deduplicating API (non-blocking)
      addToNotionSyncQueue({
        highlightId: highlightData.id,
        operationType: 'add',
        text: highlightText,
        htmlContent: highlightHtml,
      }).catch(() => {})

      // Redistribute: place only this new highlight on a remaining day
      try {
        await fetch('/api/daily/redistribute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ highlightIds: [highlightData.id] }),
        })
      } catch (error) {
        console.warn('Failed to redistribute daily assignments:', error)
      }

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
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8 sm:py-12">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 dark:text-white mb-2 sm:mb-4">
            Freedwise
          </h1>
          <p className="text-base sm:text-lg lg:text-xl text-gray-600 dark:text-gray-300 mb-6 sm:mb-8">
            Resurface your highlights in daily summaries
          </p>

          {/* Quick Add Highlight Form */}
          <form onSubmit={handleSubmit} className="mb-8 sm:mb-12 bg-white dark:bg-gray-800 p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700">
            <div className="space-y-4">
              <div>
                <RichTextEditor
                  value={text}
                  htmlValue={htmlContent}
                  onChange={(newText, newHtml) => {
                    setText(newText)
                    setHtmlContent(newHtml)
                  }}
                  placeholder="What do you want to remember?"
                />
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
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
                      className={`px-3 py-1.5 rounded-full text-sm transition ${
                        selectedCategories.includes(cat.id)
                          ? 'bg-blue-600 text-white shadow-md'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
                  {!showCategoryInput ? (
                    <button
                      type="button"
                      onClick={() => setShowCategoryInput(true)}
                      className="px-3 py-1.5 rounded-full text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition border border-dashed border-gray-300 dark:border-gray-600"
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
                        className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-full text-sm dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="New category"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={handleCreateCategory}
                        className="px-3 py-1.5 bg-blue-600 text-white rounded-full text-sm hover:bg-blue-700 transition"
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowCategoryInput(false)
                          setNewCategoryName('')
                        }}
                        className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-full text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!text.trim() || saving}
                  className="w-full sm:w-auto px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {saving ? (
                    <>
                      <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span>Saving...</span>
                    </>
                  ) : saveSuccess ? (
                    <>
                      <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            <Link
              href="/highlights"
              className="flex items-center gap-4 p-4 sm:p-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:shadow-xl transition-shadow"
            >
              <div className="flex-shrink-0 w-12 h-12 bg-blue-100 dark:bg-blue-900 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white mb-1">
                  Highlights
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Manage your highlights
                </p>
              </div>
            </Link>
            
            <Link
              href="/search"
              className="flex items-center gap-4 p-4 sm:p-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:shadow-xl transition-shadow"
            >
              <div className="flex-shrink-0 w-12 h-12 bg-green-100 dark:bg-green-900 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white mb-1">
                  Search
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Find highlights
                </p>
              </div>
            </Link>
            
            <Link
              href="/daily"
              className="flex items-center gap-4 p-4 sm:p-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:shadow-xl transition-shadow"
            >
              <div className="flex-shrink-0 w-12 h-12 bg-purple-100 dark:bg-purple-900 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white mb-1">
                  Daily Review
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Review highlights
                </p>
              </div>
            </Link>
            
            <Link
              href="/archives"
              className="flex items-center gap-4 p-4 sm:p-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:shadow-xl transition-shadow"
            >
              <div className="flex-shrink-0 w-12 h-12 bg-orange-100 dark:bg-orange-900 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white mb-1">
                  Archives
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Archived highlights
                </p>
              </div>
            </Link>
            
            <Link
              href="/pins"
              className="flex items-center gap-4 p-4 sm:p-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:shadow-xl transition-shadow"
            >
              <div className="flex-shrink-0 w-12 h-12 bg-yellow-100 dark:bg-yellow-900 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-yellow-600 dark:text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white mb-1">
                  Pin Board
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Your pinned highlights
                </p>
              </div>
            </Link>
          </div>
        </div>
      </div>
    </main>
  )
}
