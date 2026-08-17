'use client'

export function archiveActionError(
  action: 'archive' | 'unarchive',
  items: Array<{ archived?: boolean | null }>
): string | null {
  if (items.length === 0) return null
  const archivedCount = items.filter((h) => !!h.archived).length
  const activeCount = items.length - archivedCount

  if (action === 'archive') {
    if (archivedCount === 0) return null
    if (activeCount === 0) {
      return items.length === 1
        ? 'This highlight is already archived.'
        : 'These highlights are already archived.'
    }
    return 'Some selected highlights are already archived. Deselect them before archiving.'
  }

  if (activeCount === 0) return null
  if (archivedCount === 0) {
    return items.length === 1
      ? "This highlight isn't archived."
      : "These highlights aren't archived."
  }
  return "Some selected highlights aren't archived. Deselect them before unarchiving."
}

export function SelectCheck({ selected }: { selected: boolean }) {
  return (
    <div
      className={`absolute top-3 right-3 z-20 w-6 h-6 rounded-full border-2 flex items-center justify-center transition ${
        selected
          ? 'bg-blue-600 border-blue-600 text-white'
          : 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-500'
      }`}
    >
      {selected && (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      )}
    </div>
  )
}

type SelectModeBarProps = {
  selectedCount: number
  allOnPageSelected: boolean
  bulkWorking: boolean
  onTogglePage: () => void
  selectPageLabel?: string
  deselectPageLabel?: string
  onArchive?: () => void
  archiveLabel?: string
  onUnarchive?: () => void
  unarchiveLabel?: string
  onDelete: () => void
  onCancel: () => void
}

export default function SelectModeBar({
  selectedCount,
  allOnPageSelected,
  bulkWorking,
  onTogglePage,
  selectPageLabel = 'Select page',
  deselectPageLabel = 'Deselect page',
  onArchive,
  archiveLabel = 'Archive',
  onUnarchive,
  unarchiveLabel = 'Unarchive',
  onDelete,
  onCancel,
}: SelectModeBarProps) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-wrap items-center justify-center gap-2 sm:gap-3 px-4 py-3 rounded-2xl shadow-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 max-w-[calc(100vw-2rem)]">
      <span className="text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">
        {selectedCount} selected
      </span>
      <button
        onClick={onTogglePage}
        disabled={bulkWorking}
        className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-50"
      >
        {allOnPageSelected ? deselectPageLabel : selectPageLabel}
      </button>
      {onArchive && (
        <button
          onClick={onArchive}
          disabled={bulkWorking || selectedCount === 0}
          className="px-3 py-1.5 text-sm bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 rounded-lg hover:bg-orange-200 dark:hover:bg-orange-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {bulkWorking ? 'Working…' : archiveLabel}
        </button>
      )}
      {onUnarchive && (
        <button
          onClick={onUnarchive}
          disabled={bulkWorking || selectedCount === 0}
          className="px-3 py-1.5 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded-lg hover:bg-blue-200 dark:hover:bg-blue-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {bulkWorking ? 'Working…' : unarchiveLabel}
        </button>
      )}
      <button
        onClick={onDelete}
        disabled={bulkWorking || selectedCount === 0}
        className="px-3 py-1.5 text-sm bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {bulkWorking ? 'Working…' : 'Delete'}
      </button>
      <button
        onClick={onCancel}
        disabled={bulkWorking}
        className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  )
}
