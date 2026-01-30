'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

interface HighlightPreview {
  text: string
  html: string
}

// Normalize text for comparison (strip HTML, trim, lowercase, collapse whitespace)
function normalizeText(text: string): string {
  if (!text) return ''
  const plainText = text.replace(/<[^>]*>/g, '')
  return plainText.trim().toLowerCase().replace(/\s+/g, ' ')
}

export default function ImportPage() {
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [source, setSource] = useState('')
  const [author, setAuthor] = useState('')
  const [preview, setPreview] = useState<HighlightPreview[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notionApiKey, setNotionApiKey] = useState('')
  const [pageId, setPageId] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [notInNotionCount, setNotInNotionCount] = useState<number>(0)
  const [notInNotionSnippets, setNotInNotionSnippets] = useState<string[]>([])
  const supabase = createClient()

  // Pre-fill Notion API key and Page ID from settings if available
  useEffect(() => {
    let cancelled = false
    async function loadSettings() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const { data, error: fetchError } = await supabase
        .from('user_notion_settings')
        .select('notion_api_key, notion_page_id')
        .eq('user_id', user.id)
        .maybeSingle()
      if (fetchError || !data || cancelled) return
      const row = data as { notion_api_key: string; notion_page_id: string }
      if (row.notion_api_key?.trim()) setNotionApiKey(row.notion_api_key)
      if (row.notion_page_id?.trim()) setPageId(row.notion_page_id)
    }
    loadSettings()
    return () => { cancelled = true }
  }, [supabase])

  const handleFetchFromNotion = async () => {
    if (!notionApiKey.trim() || !pageId.trim()) {
      setError('Please provide both Notion API key and Page ID')
      return
    }

    setFetching(true)
    setError(null)
    setPreview([])
    setNotInNotionCount(0)
    setNotInNotionSnippets([])

    try {
      const response = await fetch('/api/notion/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pageId: pageId.trim(),
          notionApiKey: notionApiKey.trim(),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch from Notion')
      }

      if (!data.highlights || data.highlights.length === 0) {
        setError('No highlights found. Make sure your page has content separated by empty lines.')
        return
      }

      setPreview(data.highlights)

      // Compute existing highlights that are not on this Notion page (for small display)
      const { data: { user: u } } = await supabase.auth.getUser()
      if (u) {
        const existingHighlights: { text?: string; html_content?: string }[] = []
        let cursor = 0
        const pageSize = 1000
        while (true) {
          const { data: batch, error: fetchErr } = await supabase
            .from('highlights')
            .select('text, html_content')
            .eq('user_id', u.id)
            .range(cursor, cursor + pageSize - 1)
          if (fetchErr || !batch?.length) break
          existingHighlights.push(...batch)
          if (batch.length < pageSize) break
          cursor += pageSize
        }
        const notionTexts = new Set<string>()
        for (const h of data.highlights) {
          const t = normalizeText(h.text)
          const html = normalizeText(h.html)
          if (t) notionTexts.add(t)
          if (html && html !== t) notionTexts.add(html)
        }
        const notInNotion = existingHighlights.filter((h) => {
          const t = normalizeText(h.text || '')
          const html = normalizeText(h.html_content || '')
          return !(t && notionTexts.has(t)) && !(html && notionTexts.has(html))
        })
        setNotInNotionCount(notInNotion.length)
        setNotInNotionSnippets(
          notInNotion.slice(0, 5).map((h) => {
            const raw = (h.text || h.html_content || '').replace(/<[^>]*>/g, '').trim()
            return raw.length > 60 ? raw.slice(0, 57) + '...' : raw
          })
        )
      } else {
        setNotInNotionCount(0)
        setNotInNotionSnippets([])
      }
    } catch (err: any) {
      console.error('Error fetching from Notion:', err)
      setError(err.message || 'Failed to fetch from Notion. Please check your API key and page ID.')
    } finally {
      setFetching(false)
    }
  }

  const handleImport = async () => {
    if (preview.length === 0) return

    setLoading(true)
    setError(null)
    setProgress({ current: 0, total: preview.length })

    try {
      // Get authenticated user
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        throw new Error('You must be logged in to import highlights')
      }

      // Get ALL existing highlights (including archived) to check for duplicates
      // This ensures we don't create duplicates even if highlights are archived
      // Paginate through all highlights to avoid Supabase's default limit
      const existingHighlights: any[] = []
      let fetchCursor = 0
      const pageSize = 1000
      
      while (true) {
        const { data: batch, error: fetchError } = await supabase
          .from('highlights')
          .select('text, html_content, archived')
          .eq('user_id', user.id) // Only get user's own highlights
          // Note: We intentionally include archived highlights to avoid duplicates
          .range(fetchCursor, fetchCursor + pageSize - 1)
        
        if (fetchError) throw fetchError
        
        if (!batch || batch.length === 0) break
        
        existingHighlights.push(...batch)
        
        // If we got fewer than pageSize, we've reached the end
        if (batch.length < pageSize) break
        
        fetchCursor += pageSize
      }

      // Create a set of existing highlight texts (normalized for comparison)
      // Add both text and html_content (normalized) to catch duplicates regardless of which field matches
      const existingTexts = new Set<string>()
      for (const h of existingHighlights || []) {
        const textNormalized = normalizeText(h.text || '')
        const htmlNormalized = normalizeText(h.html_content || '')
        // Add both to the set (if they're different)
        if (textNormalized) existingTexts.add(textNormalized)
        if (htmlNormalized && htmlNormalized !== textNormalized) existingTexts.add(htmlNormalized)
      }

      // Filter out duplicates
      const newHighlights = preview.filter((highlight) => {
        const textNormalized = normalizeText(highlight.text)
        const htmlNormalized = normalizeText(highlight.html)
        const textMatch = textNormalized && existingTexts.has(textNormalized)
        const htmlMatch = htmlNormalized && existingTexts.has(htmlNormalized)
        return !textMatch && !htmlMatch
      })

      const skipped = preview.length - newHighlights.length

      if (newHighlights.length === 0) {
        alert(`All ${preview.length} highlights already exist in the database. No new highlights imported.`)
        setLoading(false)
        return
      }

      // Import only new highlights in batches
      const batchSize = 10
      let imported = 0
      const newHighlightIds: string[] = []

      for (let i = 0; i < newHighlights.length; i += batchSize) {
        const batch = newHighlights.slice(i, i + batchSize)
        
        const highlightsToInsert = batch.map((highlight) => ({
          text: highlight.text.trim(),
          html_content: highlight.html.trim() || null,
          source: source.trim() || null,
          author: author.trim() || null,
          resurface_count: 0,
          average_rating: 0,
          rating_count: 0,
          user_id: user.id, // Required for RLS policy
        }))

        const { data: inserted, error: insertError } = await (supabase
          .from('highlights') as any)
          .insert(highlightsToInsert)
          .select('id')

        if (insertError) throw insertError
        if (inserted?.length) {
          newHighlightIds.push(...inserted.map((row: { id: string }) => row.id))
        }

        imported += batch.length
        setProgress({ current: imported, total: newHighlights.length })
      }

      // Redistribute daily assignments so new highlights get placed on remaining days
      if (newHighlightIds.length > 0) {
        try {
          await fetch('/api/daily/redistribute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlightIds: newHighlightIds }),
          })
        } catch (error) {
          console.warn('Failed to redistribute daily assignments:', error)
        }
      }

      const message = skipped > 0
        ? `Successfully imported ${imported} new highlights. ${skipped} duplicate(s) skipped.`
        : `Successfully imported ${imported} highlights!`
      
      alert(message)
      
      // Reset form
      setPreview([])
      setSource('')
      setAuthor('')
      setProgress({ current: 0, total: 0 })
      setNotInNotionCount(0)
      setNotInNotionSnippets([])
    } catch (err: any) {
      console.error('Error importing highlights:', err)
      setError(`Failed to import highlights: ${err.message || 'Unknown error'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
              Import Highlights from Notion
            </h1>
            <Link
              href="/highlights"
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
            >
              Back to Highlights
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg space-y-6">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Import highlights from a Notion page. Each empty line (blank paragraph) in your Notion page will separate highlights. 
                Rich text formatting (bold, italic, underline, lists) will be preserved.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-500 mb-2">
                <strong>How to get your Notion API key:</strong> Go to{' '}
                <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                  notion.so/my-integrations
                </a>
                {' '}and create a new integration. Copy the &quot;Internal Integration Token&quot;.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-500">
                <strong>How to get your Page ID:</strong> Open your Notion page, click &quot;Share&quot; → &quot;Copy link&quot;. 
                The Page ID is the long string of characters at the end of the URL (after the last dash).
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Notion API Key *
              </label>
              <div className="flex gap-2">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={notionApiKey}
                  onChange={(e) => setNotionApiKey(e.target.value)}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                  placeholder="secret_..."
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition text-sm"
                >
                  {showApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Notion Page ID *
              </label>
              <input
                type="text"
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                placeholder="32-character page ID from Notion URL"
              />
            </div>

            <button
              onClick={handleFetchFromNotion}
              disabled={!notionApiKey.trim() || !pageId.trim() || fetching}
              className="w-full px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed disabled:hover:bg-gray-300 flex items-center justify-center gap-2"
            >
              {fetching ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Fetching from Notion...
                </>
              ) : (
                'Fetch Highlights from Notion'
              )}
            </button>

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Source (optional)
                </label>
                <input
                  type="text"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                  placeholder="Book, article, etc."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Author (optional)
                </label>
                <input
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                  placeholder="Author name"
                />
              </div>
            </div>

            {error && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}

            {preview.length > 0 && (
              <div>
                {notInNotionCount > 0 && (
                  <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      You have <strong>{notInNotionCount}</strong> highlight{notInNotionCount !== 1 ? 's' : ''} in your library that {notInNotionCount === 1 ? 'was' : 'were'} not found on this Notion page.
                    </p>
                    {notInNotionSnippets.length > 0 && (
                      <details className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        <summary className="cursor-pointer hover:underline">Show examples</summary>
                        <ul className="mt-1 list-disc list-inside space-y-0.5">
                          {notInNotionSnippets.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                          {notInNotionCount > 5 && (
                            <li>... and {notInNotionCount - 5} more</li>
                          )}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
                    Preview ({preview.length} highlights found)
                  </h2>
                  <button
                    onClick={() => {
                      setPreview([])
                      setNotInNotionCount(0)
                      setNotInNotionSnippets([])
                    }}
                    className="px-3 py-1 text-sm bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                  >
                    Clear
                  </button>
                </div>
                <div className="max-h-96 overflow-y-auto space-y-2 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
                  {preview.slice(0, 10).map((highlight, index) => (
                    <div
                      key={index}
                      className="p-3 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700"
                    >
                      <div
                        className="highlight-preview text-base max-w-none"
                        dangerouslySetInnerHTML={{ __html: highlight.html }}
                      />
                    </div>
                  ))}
                  {preview.length > 10 && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
                      ... and {preview.length - 10} more highlights
                    </p>
                  )}
                </div>
              </div>
            )}

            {loading && !error && (
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-2">
                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Importing highlights...
                  </span>
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    {progress.current} / {progress.total}
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                  <div
                    className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            <button
              onClick={handleImport}
              disabled={preview.length === 0 || loading}
              className="w-full px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed disabled:hover:bg-gray-300 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Importing...
                </>
              ) : (
                `Import ${preview.length} Highlights`
              )}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
