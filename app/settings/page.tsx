'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

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
      const parts = []
      if (data.repaired > 0) parts.push(`${data.repaired} highlight(s) marked as reviewed for last month`)
      if (data.removedSpuriousCurrentMonth > 0) parts.push(`${data.removedSpuriousCurrentMonth} incorrect current-month entries removed`)
      setMessage({
        type: 'success',
        text: parts.length > 0 ? `Synced: ${parts.join('. ')}.` : (data.message || 'No missing entries to sync.'),
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
      <main className="min-h-screen flex items-center justify-center" style={{ background: 'var(--background)' }}>
        <div className="text-lg" style={{ color: 'var(--text-secondary)' }}>Loading…</div>
      </main>
    )
  }

  return (
    <main className="min-h-screen" style={{ background: 'var(--background)' }}>
      <div className="container mx-auto px-4 py-10">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-8" style={{ color: 'var(--text-primary)' }}>
            Settings
          </h1>

          {/* Status message */}
          {message && (
            <div
              className={`mb-6 p-4 rounded-xl text-sm font-medium ${
                message.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/20'
                  : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-500/20'
              }`}
            >
              {message.text}
            </div>
          )}

          {/* Notion Integration */}
          <div className="glass-card p-6 sm:p-8 mb-6">
            <div className="flex items-center gap-3 mb-1">
              <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                <svg className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <div>
                <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Notion Integration</h2>
              </div>
            </div>
            <p className="text-sm mb-4 ml-12" style={{ color: 'var(--text-tertiary)' }}>
              Connect your Notion workspace to automatically sync highlights.
            </p>
            <div className="px-3 py-2 rounded-lg text-xs mb-6" style={{ background: 'var(--brand-surface)', color: 'var(--brand)' }}>
              One-way sync — changes to your Notion page will not be reflected in the app.
            </div>

            <form onSubmit={handleSave} className="space-y-5">
              {/* Toggle */}
              <div className="flex items-center justify-between">
                <label htmlFor="enabled" className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Enable Notion sync
                </label>
                <button
                  type="button"
                  id="enabled"
                  onClick={() => setSettings({ ...settings, enabled: !settings.enabled })}
                  className={`toggle-switch ${settings.enabled ? 'active' : ''}`}
                  role="switch"
                  aria-checked={settings.enabled}
                />
              </div>

              {settings.enabled && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                      Notion API Key
                    </label>
                    <div className="flex gap-2">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={settings.notion_api_key}
                        onChange={(e) => setSettings({ ...settings, notion_api_key: e.target.value })}
                        className="flex-1 input-boxed-elegant"
                        placeholder="secret_..."
                        required={settings.enabled}
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="btn-secondary !px-4 text-xs"
                      >
                        {showApiKey ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      Get your API key from{' '}
                      <a
                        href="https://www.notion.so/my-integrations"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:no-underline"
                        style={{ color: 'var(--brand)' }}
                      >
                        notion.so/my-integrations
                      </a>
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                      Notion Page ID
                    </label>
                    <input
                      type="text"
                      value={settings.notion_page_id}
                      onChange={(e) => setSettings({ ...settings, notion_page_id: e.target.value })}
                      className="input-boxed-elegant"
                      placeholder="32-character page ID"
                      required={settings.enabled}
                    />
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      Open your Notion page, click &quot;Share&quot; → &quot;Copy link&quot;. The Page ID is the long string at the end of the URL.
                    </p>
                  </div>
                </>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="btn-primary"
                >
                  {saving ? 'Saving…' : 'Save Settings'}
                </button>
                {settings.notion_api_key && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="btn-danger"
                  >
                    Delete Settings
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Last month reviewed */}
          <div className="glass-card p-6 sm:p-8 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Last month reviewed</h2>
            </div>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              {lastMonthLabel ? (
                <>In <strong>{lastMonthLabel}</strong>, you reviewed <strong>{lastMonthReviewedCount ?? '—'}</strong> highlight{lastMonthReviewedCount === 1 ? '' : 's'}.</>
              ) : (
                <>Loading…</>
              )}
            </p>
            {lastMonthLabel && unreviewedHighlights.length > 0 && (
              <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
                <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                  Not reviewed before {lastMonthLabel} ended
                </h3>
                <ul className="space-y-2">
                  {unreviewedHighlights.map((h) => {
                    const createdDate = h.created_at ? new Date(h.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
                    const assignedLabel = h.assigned_date
                      ? (() => {
                          const [, mo, day] = h.assigned_date.split('-')
                          return `Assigned to ${parseInt(mo, 10)}/${parseInt(day, 10)}`
                        })()
                      : 'Not assigned a review date'
                    return (
                      <li
                        key={h.id}
                        className="p-3 rounded-lg text-sm"
                        style={{ background: 'var(--surface-hover)' }}
                      >
                        <p className="line-clamp-2 mb-1" style={{ color: 'var(--text-primary)' }}>
                          {h.textSnippet || '(no text)'}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          Added {createdDate} · {assignedLabel}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
            {lastMonthLabel && unreviewedHighlights.length === 0 && lastMonthReviewedCount !== null && (
              <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
                All highlights that existed before {lastMonthLabel} ended were reviewed (or none existed).
              </p>
            )}
            {lastMonthLabel && (
              <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
                <p className="text-xs mb-2" style={{ color: 'var(--text-tertiary)' }}>
                  If you rated highlights but lost connection during review, the &quot;reviewed&quot; list may be out of sync.
                </p>
                <button
                  type="button"
                  onClick={handleSyncReviewedStatus}
                  disabled={syncingRepair}
                  className="btn-secondary text-xs"
                >
                  {syncingRepair ? 'Syncing…' : 'Sync reviewed status for last month'}
                </button>
              </div>
            )}
          </div>

          {/* Danger Zone */}
          <div className="glass-card p-6 sm:p-8 mb-6" style={{ borderColor: 'var(--danger)', borderWidth: '1px' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-red-50 dark:bg-red-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Reset daily highlights</h2>
            </div>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              This will remove all ratings and &quot;reviewed&quot; status for the current month, then reassign all highlights evenly. You will need to review them again.
            </p>
            <div className="px-3 py-2 rounded-lg text-xs mb-4 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-500/20">
              ⚠️ This cannot be undone. All progress for this month will be lost.
            </div>
            {showResetConfirm && (
              <div className="mb-4 p-4 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                <p className="text-sm text-red-700 dark:text-red-300 mb-3">
                  Click &quot;Yes, reset monthly highlights&quot; again to confirm.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleResetDailyHighlights}
                    disabled={resettingDaily}
                    className="btn-danger text-sm"
                  >
                    {resettingDaily ? 'Resetting…' : 'Yes, reset monthly highlights'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowResetConfirm(false)}
                    disabled={resettingDaily}
                    className="btn-secondary text-sm"
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
                className="btn-danger"
              >
                {resettingDaily ? 'Resetting…' : 'Reset all daily highlights for this month'}
              </button>
            )}
          </div>

          {/* Debug section */}
          <div className="glass-card p-6 sm:p-8" style={{ borderColor: 'var(--warning)', borderWidth: '1px' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Debug: last day of month</h2>
            </div>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              Run daily redistribution as if today were the last day of the month. Use this to test that highlights added on the last day get assigned and to assign any orphans.
            </p>
            <button
              type="button"
              onClick={handleDebugLastDayRedistribute}
              disabled={debugRedistributing}
              className="btn-secondary"
              style={{ borderColor: 'var(--warning)' }}
            >
              {debugRedistributing ? 'Running…' : 'Redistribute (debug last day)'}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
