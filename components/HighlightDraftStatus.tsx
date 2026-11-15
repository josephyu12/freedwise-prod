'use client'

export default function HighlightDraftStatus({ composer, disabled = false }: {
  composer: {
    draftStatus: string | null
    error: string | null
    otherDrafts: { key: string; text: string }[]
    recoverDraft: (key: string) => void
  }
  disabled?: boolean
}) {
  return <>
    {composer.draftStatus && <p role="status" className="mt-2 text-sm text-gray-500">{composer.draftStatus}</p>}
    {composer.error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{composer.error}</p>}
    {composer.otherDrafts.length > 0 && (
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">Other drafts on this device ({composer.otherDrafts.length})</summary>
        <ul className="mt-2 space-y-2">
          {composer.otherDrafts.map((draft) => <li key={draft.key}>
            <button type="button" disabled={disabled} onClick={() => composer.recoverDraft(draft.key)} className="text-left underline disabled:opacity-50">
              Recover: {draft.text.slice(0, 100)}{draft.text.length > 100 ? '…' : ''}
            </button>
          </li>)}
        </ul>
      </details>
    )}
  </>
}
