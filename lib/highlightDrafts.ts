export interface HighlightDraft {
  text: string
  html: string
  categories: string[]
  ids?: string[]
  createdAt?: string
}

export interface StoredHighlightDraft {
  key: string
  raw: string
  draft: HighlightDraft
  updatedAt: number
}

export const highlightDraftPrefix = (userId: string, scope: string) =>
  `freedwise:highlight-draft:v1:${userId}:${scope}:`

export function readHighlightDrafts(prefix: string): StoredHighlightDraft[] {
  const drafts: StoredHighlightDraft[] = []
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)
    if (!key?.startsWith(prefix)) continue
    const raw = window.localStorage.getItem(key)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.text !== 'string' || !parsed.text.trim() || typeof parsed.html !== 'string' ||
          !Array.isArray(parsed.categories) || !parsed.categories.every((c: unknown) => typeof c === 'string')) continue
      const draft: HighlightDraft = { text: parsed.text, html: parsed.html, categories: parsed.categories }
      if (Array.isArray(parsed.ids) && parsed.ids.every((id: unknown) => typeof id === 'string') &&
          typeof parsed.createdAt === 'string' && Number.isFinite(Date.parse(parsed.createdAt))) {
        draft.ids = parsed.ids
        draft.createdAt = parsed.createdAt
      }
      drafts.push({ key, raw, draft, updatedAt: Number(parsed.updatedAt) || 0 })
    } catch {
      // Retain malformed records; one broken backup must not hide good drafts.
    }
  }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
}
