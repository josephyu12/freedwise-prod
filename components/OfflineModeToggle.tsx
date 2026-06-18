'use client'

import { useManualOffline } from '@/hooks/useManualOffline'

type OfflineModeToggleProps = {
  // 'icon' for the desktop header (compact pill); 'full' for the mobile drawer
  // where a labeled, full-width row reads better.
  variant?: 'icon' | 'full'
}

/**
 * User-controlled "stay offline" switch. Lets the user manually enter offline
 * mode on a weak/flapping connection so the app stops pinging and won't reload
 * mid-review. Backed by useManualOffline (persisted + broadcast), so flipping it
 * here updates every page's connectivity state and the global sync drainer.
 */
export default function OfflineModeToggle({ variant = 'icon' }: OfflineModeToggleProps) {
  const { manualOffline, setManualOffline } = useManualOffline()

  const label = manualOffline ? 'Offline mode on — tap to go online' : 'Go offline (stops syncing)'

  const icon = manualOffline ? (
    // Slashed Wi-Fi — explicitly offline
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 5.636L5.636 18.364M8.111 16.404a5 5 0 017.778 0M12 20h.01M2 8.82a15 15 0 0120 0" />
    </svg>
  ) : (
    // Wi-Fi — online
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5 5 0 017.778 0M12 20h.01M5.05 12.96a10 10 0 0113.9 0M2 8.82a15 15 0 0120 0" />
    </svg>
  )

  if (variant === 'full') {
    return (
      <button
        onClick={() => setManualOffline(!manualOffline)}
        aria-pressed={manualOffline}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm rounded-lg transition-colors text-left ${
          manualOffline
            ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20'
            : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
        }`}
      >
        {icon}
        {manualOffline ? 'Offline mode on — go online' : 'Go offline'}
      </button>
    )
  }

  return (
    <button
      onClick={() => setManualOffline(!manualOffline)}
      aria-pressed={manualOffline}
      aria-label={label}
      title={label}
      className={`flex items-center justify-center w-9 h-9 rounded-xl border shadow-sm transition-all duration-200 ${
        manualOffline
          ? 'bg-amber-100 dark:bg-amber-900/40 border-amber-300/70 dark:border-amber-700/60 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/60'
          : 'bg-white/80 dark:bg-white/10 backdrop-blur-md border-gray-200/60 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:shadow-md hover:bg-white dark:hover:bg-white/15'
      }`}
    >
      {icon}
    </button>
  )
}
