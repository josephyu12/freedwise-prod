'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function CleanupPage() {
  const [date, setDate] = useState('2026-01-26')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const supabase = createClient()
  const router = useRouter()

  const handleCleanup = async () => {
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch('/api/daily/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to cleanup')
      }

      setResult(data)
    } catch (err: any) {
      setError(err.message || 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-8">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
            Cleanup Daily Summary
          </h1>
          
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            This will remove all unrated highlights from the specified date. 
            Highlights with ratings will be preserved.
          </p>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Date (YYYY-MM-DD)
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
            />
          </div>

          <button
            onClick={handleCleanup}
            disabled={loading || !date}
            className="w-full px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Cleaning up...' : 'Remove Unrated Highlights'}
          </button>

          {error && (
            <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-red-800 dark:text-red-200">{error}</p>
            </div>
          )}

          {result && (
            <div className="mt-4 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
              <p className="text-green-800 dark:text-green-200 font-semibold mb-2">
                {result.message}
              </p>
              <div className="text-sm text-green-700 dark:text-green-300 space-y-1">
                <p>Removed: {result.removedCount} highlight(s)</p>
                <p>Remaining: {result.remainingHighlights} highlight(s) with ratings</p>
                <p>Total before cleanup: {result.totalHighlights} highlight(s)</p>
              </div>
            </div>
          )}

          <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={() => router.push('/daily')}
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              ← Back to Daily Summary
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
