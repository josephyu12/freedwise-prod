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
        </div>
      </div>
    </main>
  )
}

