'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface NotionSettings {
  id?: string
  notion_api_key: string
  notion_page_id: string
  enabled: boolean
}

export default function SettingsPage() {
  const supabase = createClient()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<NotionSettings>({
    notion_api_key: '',
    notion_page_id: '',
    enabled: true,
  })
  const [showApiKey, setShowApiKey] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [resettingDaily, setResettingDaily] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [debugRedistributing, setDebugRedistributing] = useState(false)
  const [lastMonthReviewedCount, setLastMonthReviewedCount] = useState<number | null>(null)
  const [lastMonthLabel, setLastMonthLabel] = useState<string>('')
  const [syncingRepair, setSyncingRepair] = useState(false)
  const [unreviewedHighlights, setUnreviewedHighlights] = useState<Array<{
    id: string
    textSnippet: string
    created_at: string
    assigned_date: string | null
  }>>([])

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }

      const { data: settingsData, error } = await supabase
        .from('user_notion_settings')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle()

      if (error && error.code !== 'PGRST116') throw error

      if (settingsData) {
        const data = settingsData as { notion_api_key: string; notion_page_id: string; enabled: boolean }
        setSettings({
          notion_api_key: data.notion_api_key,
          notion_page_id: data.notion_page_id,
          enabled: data.enabled,
        })
      }
    } catch (error) {
      console.error('Error loading settings:', error)
      setMessage({ type: 'error', text: 'Failed to load settings' })
    } finally {
      setLoading(false)
    }
  }, [supabase, router])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const loadLastMonthReviewedCount = useCallback(async () => {
    try {
      const res = await fetch('/api/stats/reviewed-count')
      if (!res.ok) return
      const data = await res.json()
      setLastMonthReviewedCount(data.count ?? 0)
      setUnreviewedHighlights(Array.isArray(data.unreviewedHighlights) ? data.unreviewedHighlights : [])
      if (data.month) {
        const [y, m] = data.month.split('-')
        const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
        setLastMonthLabel(d.toLocaleString('default', { month: 'long', year: 'numeric' }))
      }
    } catch {
      // ignore
    }
  }, [])

  const handleSyncReviewedStatus = useCallback(async () => {
    setSyncingRepair(true)
    setMessage(null)
    try {
      const res = await fetch('/api/stats/reviewed-count/repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Failed to sync reviewed status' })
        return
      }
      await loadLastMonthReviewedCount()
      setMessage({
        type: 'success',
        text: data.repaired > 0
          ? `Synced reviewed status: ${data.repaired} highlight(s) marked as reviewed for last month.`
          : (data.message || 'No missing entries to sync.'),
      })
    } catch {
      setMessage({ type: 'error', text: 'Failed to sync reviewed status' })
    } finally {
      setSyncingRepair(false)
    }
  }, [loadLastMonthReviewedCount])

  useEffect(() => {
    loadLastMonthReviewedCount()
  }, [loadLastMonthReviewedCount])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }

      // Validate that if enabled, both fields are provided
      if (settings.enabled && (!settings.notion_api_key.trim() || !settings.notion_page_id.trim())) {
        setMessage({ type: 'error', text: 'Please provide both API key and Page ID to enable Notion sync' })
        setSaving(false)
        return
      }

      const { error } = await (supabase
        .from('user_notion_settings') as any)
        .upsert({
          user_id: user.id,
          notion_api_key: settings.notion_api_key.trim(),
          notion_page_id: settings.notion_page_id.trim(),
          enabled: settings.enabled,
        }, {
          onConflict: 'user_id'
        })

      if (error) throw error

      setMessage({ type: 'success', text: 'Settings saved successfully!' })
    } catch (error: any) {
      console.error('Error saving settings:', error)
      setMessage({ type: 'error', text: error.message || 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const handleResetDailyHighlights = async () => {
    if (!showResetConfirm) {
      setShowResetConfirm(true)
      return
    }

    setResettingDaily(true)
    setMessage(null)
    setShowResetConfirm(false)

    try {
      const res1 = await fetch('/api/daily/reset-month', { method: 'POST' })
      if (!res1.ok) {
        const data = await res1.json()
        throw new Error(data.error || 'Reset failed')
      }

      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() + 1

      const res2 = await fetch('/api/daily/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month }),
      })
      if (!res2.ok) {
        const data = await res2.json()
        throw new Error(data.error || 'Reassign failed')
      }

      setMessage({ type: 'success', text: 'Daily highlights reset and reassigned for this month.' })
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to reset daily highlights' })
    } finally {
      setResettingDaily(false)
    }
  }

  const handleDebugLastDayRedistribute = async () => {
    setDebugRedistributing(true)
    setMessage(null)
    try {
      const res = await fetch('/api/daily/redistribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugLastDay: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Redistribute failed')
      }
      const detail = data.effectiveDate
        ? ` (pretended today is ${data.effectiveDate}, day ${data.effectiveDay})`
        : ''
      setMessage({
        type: 'success',
        text: data.message + (detail || '') + (data.totalHighlights ? ` ${data.totalHighlights} highlight(s) assigned.` : ''),
      })
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to run redistribute (debug last day)' })
    } finally {
      setDebugRedistributing(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete your Notion settings? This will disable Notion sync.')) {
      return
    }

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { error } = await (supabase
        .from('user_notion_settings') as any)
        .delete()
        .eq('user_id', user.id)

      if (error) throw error

      setSettings({
        notion_api_key: '',
        notion_page_id: '',
        enabled: false,
      })
      setMessage({ type: 'success', text: 'Notion settings deleted successfully' })
    } catch (error: any) {
      console.error('Error deleting settings:', error)
      setMessage({ type: 'error', text: error.message || 'Failed to delete settings' })
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white">
              Settings
            </h1>
            <Link
              href="/"
              className="flex items-center gap-2 px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition text-sm sm:text-base"
            >
              <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              <span className="hidden sm:inline">Home</span>
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg">
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
              Notion Integration
            </h2>
            <p className="text-gray-600 dark:text-gray-300 mb-6">
              Connect your Notion workspace to automatically sync highlights. Your credentials are stored securely and only used for your account.
            </p>
            <p className="text-gray-600 dark:text-gray-300 mb-6">
              <b>NOTE: This is a one-way sync. Changes to your Notion page will not be reflected in the app.</b>
            </p>


            <form onSubmit={handleSave} className="space-y-6">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="enabled"
                  checked={settings.enabled}
                  onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                  className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500"
                />
                <label htmlFor="enabled" className="text-gray-700 dark:text-gray-300 font-medium">
                  Enable Notion sync
                </label>
              </div>

              {settings.enabled && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Notion API Key *
                    </label>
                    <div className="flex gap-2">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={settings.notion_api_key}
                        onChange={(e) => setSettings({ ...settings, notion_api_key: e.target.value })}
                        className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                        placeholder="secret_..."
                        required={settings.enabled}
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition text-sm"
                      >
                        {showApiKey ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Get your API key from{' '}
                      <a
                        href="https://www.notion.so/my-integrations"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        notion.so/my-integrations
                      </a>
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Notion Page ID *
                    </label>
                    <input
                      type="text"
                      value={settings.notion_page_id}
                      onChange={(e) => setSettings({ ...settings, notion_page_id: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                      placeholder="32-character page ID from Notion URL"
                      required={settings.enabled}
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Open your Notion page, click &quot;Share&quot; → &quot;Copy link&quot;. The Page ID is the long string of characters at the end of the URL (after the last dash).
                    </p>
                  </div>
                </>
              )}

              {message && (
                <div
                  className={`p-4 rounded-lg ${
                    message.type === 'success'
                      ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                      : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                  }`}
                >
                  <p
                    className={`text-sm ${
                      message.type === 'success'
                        ? 'text-green-800 dark:text-green-200'
                        : 'text-red-800 dark:text-red-200'
                    }`}
                  >
                    {message.text}
                  </p>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
                {settings.notion_api_key && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
                  >
                    Delete Settings
                  </button>
                )}
              </div>
            </form>
          </div>

          <div className="mt-8 bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg">
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
              Last month reviewed
            </h2>
            <p className="text-gray-600 dark:text-gray-300 mb-4">
              {lastMonthLabel ? (
                <>In <strong>{lastMonthLabel}</strong>, you reviewed <strong>{lastMonthReviewedCount ?? '—'}</strong> highlight{lastMonthReviewedCount === 1 ? '' : 's'}.</>
              ) : (
                <>Loading…</>
              )}
            </p>
            {lastMonthLabel && unreviewedHighlights.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-600">
                <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                  Highlights added before {lastMonthLabel} ended that were not reviewed
                </h3>
                <ul className="space-y-3">
                  {unreviewedHighlights.map((h) => {
                    const createdDate = h.created_at ? new Date(h.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
                    const assignedLabel = h.assigned_date
                      ? (() => {
                          const [yr, mo, day] = h.assigned_date.split('-')
                          return `Assigned to ${parseInt(mo, 10)}/${parseInt(day, 10)}`
                        })()
                      : 'Not assigned a review date'
                    return (
                      <li
                        key={h.id}
                        className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-sm"
                      >
                        <p className="text-gray-800 dark:text-gray-200 line-clamp-2 mb-1">
                          {h.textSnippet || '(no text)'}
                        </p>
                        <p className="text-gray-500 dark:text-gray-400 text-xs">
                          Added {createdDate} · {assignedLabel}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
            {lastMonthLabel && unreviewedHighlights.length === 0 && lastMonthReviewedCount !== null && (
              <p className="text-gray-500 dark:text-gray-400 text-sm mt-2">
                All highlights that existed before {lastMonthLabel} ended were reviewed (or none existed).
              </p>
            )}
            {lastMonthLabel && (
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-600">
                <p className="text-gray-600 dark:text-gray-300 text-sm mb-2">
                  If you rated highlights but lost connection during review, the &quot;reviewed&quot; list may be out of sync. Use this to backfill last month.
                </p>
                <button
                  type="button"
                  onClick={handleSyncReviewedStatus}
                  disabled={syncingRepair}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {syncingRepair ? 'Syncing…' : 'Sync reviewed status for last month'}
                </button>
              </div>
            )}
          </div>

          <div className="mt-8 bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg border border-red-200 dark:border-red-900/50">
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
              Reset daily highlights (this month)
            </h2>
            <p className="text-gray-600 dark:text-gray-300 mb-4">
              This will remove all ratings and &quot;reviewed&quot; status for the current month, then reassign all highlights evenly across the month. You will need to review them again.
            </p>
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 mb-4">
              <p className="text-amber-800 dark:text-amber-200 text-sm font-medium">
                Warning: This cannot be undone. All progress for this month will be lost.
              </p>
            </div>
            {showResetConfirm && (
              <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-800 dark:text-red-200 text-sm mb-3">
                  Click &quot;Yes, reset monthly highlights&quot; again to confirm.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleResetDailyHighlights}
                    disabled={resettingDaily}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {resettingDaily ? 'Resetting...' : 'Yes, reset monthly highlights'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowResetConfirm(false)}
                    disabled={resettingDaily}
                    className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {!showResetConfirm && (
              <button
                type="button"
                onClick={handleResetDailyHighlights}
                disabled={resettingDaily}
                className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resettingDaily ? 'Resetting...' : 'Reset all daily highlights for this month'}
              </button>
            )}
          </div>

          <div className="mt-8 bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg border border-amber-200 dark:border-amber-900/50">
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
              Debug: last day of month
            </h2>
            <p className="text-gray-600 dark:text-gray-300 mb-4">
              Run daily redistribution as if today were the last day of the month (e.g. the 31st). Use this to test that highlights added on the last day get assigned to that day and to assign any orphans to the last day.
            </p>
            <button
              type="button"
              onClick={handleDebugLastDayRedistribute}
              disabled={debugRedistributing}
              className="px-6 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {debugRedistributing ? 'Running...' : 'Redistribute (debug last day)'}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}

