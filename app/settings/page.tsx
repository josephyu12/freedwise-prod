'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import NotionSyncButton from '@/components/NotionSyncButton'
import { getUserReviewSettings, FREQUENCY_OPTIONS } from '@/lib/cycle'

interface NotionSettings {
  id?: string
  notion_api_key: string
  notion_page_id: string
  enabled: boolean
}

function localDateString(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
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
  const [lastMonthReviewedCount, setLastMonthReviewedCount] = useState<number | null>(null)
  const [lastMonthLabel, setLastMonthLabel] = useState<string>('')
  const [syncingRepair, setSyncingRepair] = useState(false)
  // Review cadence + on/off.
  const [reviewEnabled, setReviewEnabled] = useState(true)
  const [frequency, setFrequency] = useState(1)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [showFreqConfirm, setShowFreqConfirm] = useState<number | null>(null)
  const [unreviewedHighlights, setUnreviewedHighlights] = useState<Array<{
    id: string
    textSnippet: string
    created_at: string
    assigned_date: string | null
    archived: boolean
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

  // Surface any flash message stashed before a hard reload (e.g. after a
  // cadence change, which reloads so all cadence-dependent state re-fetches).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('settingsFlash')
      if (raw) {
        sessionStorage.removeItem('settingsFlash')
        setMessage(JSON.parse(raw))
      }
    } catch {
      /* ignore */
    }
  }, [])

  const loadLastMonthReviewedCount = useCallback(async () => {
    try {
      const res = await fetch('/api/stats/reviewed-count')
      if (!res.ok) return
      const data = await res.json()
      setLastMonthReviewedCount(data.count ?? 0)
      setUnreviewedHighlights(Array.isArray(data.unreviewedHighlights) ? data.unreviewedHighlights : [])
      if (data.cycleLabel) {
        setLastMonthLabel(data.cycleLabel)
      } else if (data.month) {
        const [y, m] = data.month.split('-')
        const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
        setLastMonthLabel(d.toLocaleString('default', { month: 'long', year: 'numeric' }))
      }
    } catch {
      // ignore
    }
  }, [])

  const loadReviewSettings = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const s = await getUserReviewSettings(supabase, user.id)
      setReviewEnabled(s.enabled)
      setFrequency(s.freq)
    } catch {
      /* keep defaults */
    }
  }, [supabase])

  useEffect(() => {
    loadReviewSettings()
  }, [loadReviewSettings])

  // Toggle daily review on/off. OFF preserves the current schedule exactly.
  // ON additionally clears any unreviewed backlog left in cycles that elapsed
  // while review was off, so re-enabling resumes from the current cycle instead
  // of greeting you with months of stale "waiting" highlights.
  const handleToggleReview = useCallback(async (next: boolean) => {
    if (!next) {
      if (!confirm('Turn daily review off? Your highlights stay scheduled exactly as they are — they just stop showing until you turn it back on.')) {
        return
      }
    }
    setReviewBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/daily/set-enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next, localDate: localDateString() }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update setting')
      }
      setReviewEnabled(next)
      // Refresh the cadence-dependent UI (reviewed count, unreviewed list,
      // cycle label) and revalidate the route so nothing is stale.
      await loadLastMonthReviewedCount()
      router.refresh()
      setMessage({ type: 'success', text: next ? 'Daily review turned on — your schedule is exactly where you left it.' : 'Daily review turned off. Your schedule is preserved.' })
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to update setting' })
    } finally {
      setReviewBusy(false)
    }
  }, [loadLastMonthReviewedCount, router])

  // Apply a new review frequency (re-tiles the current cycle, D7).
  const handleApplyFrequency = useCallback(async (value: number) => {
    setShowFreqConfirm(null)
    setReviewBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/daily/apply-frequency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency: value, localDate: localDateString() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to apply frequency')
      // The cycle was re-tiled server-side. This is a pure client component, so
      // router.refresh() won't re-fetch our local state (frequency, cycle
      // label, reviewed counts). Do a full reload so everything reflects the
      // new cadence, carrying the success message across via sessionStorage.
      try {
        sessionStorage.setItem('settingsFlash', JSON.stringify({ type: 'success', text: 'Review frequency updated.' }))
      } catch {
        /* ignore */
      }
      window.location.reload()
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to apply frequency' })
      setReviewBusy(false)
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
      if (data.repaired > 0) parts.push(`${data.repaired} highlight(s) marked as reviewed for last cycle`)
      if (data.removedSpuriousCurrentMonth > 0) parts.push(`${data.removedSpuriousCurrentMonth} incorrect current-cycle entries removed`)
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
      const today = localDateString()
      const res1 = await fetch('/api/daily/reset-cycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localDate: today }),
      })
      if (!res1.ok) {
        const data = await res1.json()
        throw new Error(data.error || 'Reset failed')
      }

      const [year, month] = today.split('-').map(Number)
      const res2 = await fetch('/api/daily/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month }),
      })
      if (!res2.ok) {
        const data = await res2.json()
        throw new Error(data.error || 'Reassign failed')
      }

      setMessage({ type: 'success', text: 'Daily highlights reset and reassigned for this cycle.' })
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to reset daily highlights' })
    } finally {
      setResettingDaily(false)
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

            {settings.enabled && settings.notion_api_key && settings.notion_page_id && (
              <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                <div className="rounded-lg border-2 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/15 p-4 mb-4">
                  <div className="flex items-start gap-3">
                    <svg
                      className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.8}
                        d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"
                      />
                    </svg>
                    <div>
                      <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                        Sync to Notion is manual — you have to press the button below
                      </h3>
                      <p className="text-xs mt-1.5 text-amber-800 dark:text-amber-300/90 leading-relaxed">
                        Adding, editing, and deleting highlights in Freedwise queues changes locally
                        but does <strong>not</strong> push them to Notion on its own. Press
                        <strong> Sync Notion</strong> below whenever you want your Notion page
                        updated. The pending count on the button shows how many changes are waiting.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Run sync now
                    </h3>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      Keep this tab open while the sync runs.
                    </p>
                  </div>
                  <NotionSyncButton />
                </div>
              </div>
            )}
          </div>

          {/* Daily review cadence */}
          <div className="glass-card p-6 sm:p-8 mb-6">
            <div className="flex items-center gap-3 mb-1">
              <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Daily review</h2>
            </div>
            <p className="text-sm mb-5 ml-12" style={{ color: 'var(--text-tertiary)' }}>
              Choose how often your whole library cycles through daily review — or turn it off entirely.
            </p>

            {/* On/off toggle */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <label htmlFor="review-enabled" className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Enable daily review
                </label>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  When off, no new highlights are resurfaced. Past reviews are kept.
                </p>
              </div>
              <button
                type="button"
                id="review-enabled"
                disabled={reviewBusy}
                onClick={() => handleToggleReview(!reviewEnabled)}
                className={`toggle-switch ${reviewEnabled ? 'active' : ''}`}
                role="switch"
                aria-checked={reviewEnabled}
              />
            </div>

            {/* Frequency selector */}
            <div className={reviewEnabled ? '' : 'opacity-50 pointer-events-none'}>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                Review frequency
              </label>
              <div className="flex flex-wrap gap-2">
                {FREQUENCY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={reviewBusy || !reviewEnabled}
                    onClick={() => {
                      if (opt.value === frequency) return
                      setShowFreqConfirm(opt.value)
                    }}
                    className={`px-3 py-1.5 rounded-full text-sm transition ${
                      opt.value === frequency
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {showFreqConfirm !== null && (
                <div className="mt-4 p-4 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20">
                  <p className="text-sm text-amber-800 dark:text-amber-300 mb-3">
                    Change review frequency to{' '}
                    <strong>{FREQUENCY_OPTIONS.find((o) => o.value === showFreqConfirm)?.label}</strong>?
                    Highlights already reviewed in the new cycle stay done on their dates; everything
                    else is re-spread across the days left. A longer cadence means each highlight comes
                    up less often. Nothing is deleted, and switching back restores the same layout.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={reviewBusy}
                      onClick={() => handleApplyFrequency(showFreqConfirm)}
                      className="btn-primary !px-4 !py-2 text-sm"
                    >
                      {reviewBusy ? 'Applying…' : 'Apply new frequency'}
                    </button>
                    <button
                      type="button"
                      disabled={reviewBusy}
                      onClick={() => setShowFreqConfirm(null)}
                      className="btn-secondary text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Last cycle reviewed */}
          <div className="glass-card p-6 sm:p-8 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Last cycle reviewed</h2>
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
                        <div className="flex items-start gap-2 mb-1">
                          <p className="line-clamp-2 flex-1" style={{ color: 'var(--text-primary)' }}>
                            {h.textSnippet || '(no text)'}
                          </p>
                          {h.archived && (
                            <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                              </svg>
                              Archived
                            </span>
                          )}
                        </div>
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
                  {syncingRepair ? 'Syncing…' : 'Sync reviewed status for last cycle'}
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
              This will remove all ratings and &quot;reviewed&quot; status for the current cycle, then reassign all highlights evenly. You will need to review them again.
            </p>
            <div className="px-3 py-2 rounded-lg text-xs mb-4 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-500/20">
              ⚠️ This cannot be undone. All progress for this cycle will be lost.
            </div>
            {showResetConfirm && (
              <div className="mb-4 p-4 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                <p className="text-sm text-red-700 dark:text-red-300 mb-3">
                  Click &quot;Yes, reset this cycle&apos;s highlights&quot; again to confirm.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleResetDailyHighlights}
                    disabled={resettingDaily}
                    className="btn-danger text-sm"
                  >
                    {resettingDaily ? 'Resetting…' : 'Yes, reset this cycle’s highlights'}
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
                {resettingDaily ? 'Resetting…' : 'Reset all daily highlights for this cycle'}
              </button>
            )}
          </div>

        </div>
      </div>
    </main>
  )
}
