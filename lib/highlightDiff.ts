import {
  blockEditSimilarity,
  blocksMatchForCompare,
  highlightToBlockTexts,
  normalizeForBlockCompare,
} from './notionBlocks'

export interface ModifiedBlock {
  oldText: string
  newText: string
  diffHtml: string
}

export interface HighlightBlockDiff {
  added: string[]
  removed: string[]
  modified: ModifiedBlock[]
  hasPrevious: boolean
}

function tokenizeWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function wordsMatchForCompare(a: string, b: string): boolean {
  return normalizeForBlockCompare(a) === normalizeForBlockCompare(b)
}

type WordDiffOp =
  | { type: 'equal'; word: string }
  | { type: 'delete'; word: string }
  | { type: 'insert'; word: string }

function wordDiffOps(oldWords: string[], newWords: string[]): WordDiffOp[] {
  const n = oldWords.length
  const m = newWords.length
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (wordsMatchForCompare(oldWords[i - 1], newWords[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const ops: WordDiffOp[] = []
  let i = n
  let j = m

  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      wordsMatchForCompare(oldWords[i - 1], newWords[j - 1])
    ) {
      ops.push({ type: 'equal', word: newWords[j - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', word: newWords[j - 1] })
      j--
    } else {
      ops.push({ type: 'delete', word: oldWords[i - 1] })
      i--
    }
  }

  return ops.reverse()
}

export function diffWordsToHtml(oldText: string, newText: string): string {
  const oldWords = tokenizeWords(oldText)
  const newWords = tokenizeWords(newText)
  const ops = wordDiffOps(oldWords, newWords)

  const parts: string[] = []
  for (const op of ops) {
    if (op.type === 'equal') {
      parts.push(escapeHtml(op.word))
    } else if (op.type === 'delete') {
      parts.push(
        `<del class="bg-red-200/80 dark:bg-red-900/50 text-red-900 dark:text-red-100 line-through rounded px-0.5">${escapeHtml(op.word)}</del>`
      )
    } else {
      parts.push(
        `<ins class="bg-green-200/80 dark:bg-green-900/50 text-green-900 dark:text-green-100 no-underline rounded px-0.5">${escapeHtml(op.word)}</ins>`
      )
    }
  }

  return parts.join(' ')
}

function pairModifiedBlocks(
  removed: string[],
  added: string[]
): {
  modified: ModifiedBlock[]
  remainingRemoved: string[]
  remainingAdded: string[]
} {
  const candidates: Array<{ oldIndex: number; newIndex: number; score: number }> = []

  for (let i = 0; i < removed.length; i++) {
    for (let j = 0; j < added.length; j++) {
      const score = blockEditSimilarity(removed[i], added[j])
      if (score > 0) {
        candidates.push({ oldIndex: i, newIndex: j, score })
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score)

  const usedOld = new Set<number>()
  const usedNew = new Set<number>()
  const modified: ModifiedBlock[] = []

  for (const { oldIndex, newIndex } of candidates) {
    if (usedOld.has(oldIndex) || usedNew.has(newIndex)) continue
    usedOld.add(oldIndex)
    usedNew.add(newIndex)
    const oldText = removed[oldIndex]
    const newText = added[newIndex]
    modified.push({
      oldText,
      newText,
      diffHtml: diffWordsToHtml(oldText, newText),
    })
  }

  return {
    modified,
    remainingRemoved: removed.filter((_, index) => !usedOld.has(index)),
    remainingAdded: added.filter((_, index) => !usedNew.has(index)),
  }
}

/**
 * Compare two highlight versions using the same block segmentation and
 * normalization rules as Notion sync. Exact blocks are ignored; similar
 * unmatched blocks get a word-level diff.
 */
export function getHighlightBlockDiff(
  previousHtml: string | null | undefined,
  previousText: string | null | undefined,
  currentHtml: string | null | undefined,
  currentText: string | null | undefined
): HighlightBlockDiff {
  const hasPrevious = !!(previousText?.trim() || previousHtml?.trim())

  const oldBlocks = highlightToBlockTexts(previousHtml, previousText)
  const newBlocks = highlightToBlockTexts(currentHtml, currentText)

  const oldPool = new Map<string, string[]>()
  for (const block of oldBlocks) {
    const key = normalizeForBlockCompare(block)
    if (!key) continue
    const arr = oldPool.get(key) || []
    arr.push(block)
    oldPool.set(key, arr)
  }

  const unmatchedAdded: string[] = []
  for (const block of newBlocks) {
    const key = normalizeForBlockCompare(block)
    if (!key) continue
    const pool = oldPool.get(key)
    if (pool && pool.length > 0) {
      pool.pop()
    } else {
      unmatchedAdded.push(block)
    }
  }

  const unmatchedRemoved: string[] = []
  for (const blocks of oldPool.values()) {
    unmatchedRemoved.push(...blocks)
  }

  const { modified, remainingRemoved, remainingAdded } = pairModifiedBlocks(
    unmatchedRemoved,
    unmatchedAdded
  )

  return {
    added: remainingAdded,
    removed: remainingRemoved,
    modified,
    hasPrevious,
  }
}
