// Freedwise Quick Review Widget for Scriptable (iOS)
//
// Supports Home Screen widgets (small / medium / large) and Lock Screen
// accessory widgets (accessoryRectangular / accessoryInline / accessoryCircular).
//
// The widget pre-fetches a batch of unrated highlights and rotates through
// them between iOS-scheduled refreshes so each glance is more likely to land
// on something new.

// NOTE: The Scriptable method is fundamentally unable to support proper rich text formatting.
// If you would like a true widget that is able to fully format text, make an iOS app

// Setup:
// 1. Install "Scriptable" from the App Store
// 2. Create a new script and paste this entire file
// 3. Open freedwise.vercel.app/widget-auth in Safari to get your token
// 4. Paste the token below as WIDGET_TOKEN (temporarily)
// 5. Run the script ONCE by tapping the Play button (not as widget)
// 6. After seeing "Token stored securely", CLEAR the token from line 28 below
// 7. Add a Scriptable widget to your home screen OR lock screen
// 8. Long-press the widget > Edit Widget > choose this script
//
// Tap the widget to open today's review in the app.
// To revoke access, go to Settings in the Freedwise app.

// ============ CONFIGURATION ============
const APP_URL = 'https://freedwise.vercel.app'
const WIDGET_TOKEN = '' // <-- Paste token here temporarily, then CLEAR after first run
// =======================================

const KEYCHAIN_KEY = 'freedwise_widget_token'
const BATCH_CACHE_FILE = 'freedwise_widget_batch.json'
const BATCH_SIZE = 10
const BATCH_TTL_MS = 30 * 60 * 1000 // 30 min — re-fetch the batch this often
const ROTATION_MS = 5 * 60 * 1000   // pick a different highlight every 5 min slot
const REFRESH_HINT_MS = 5 * 60 * 1000 // hint iOS to re-run the script soon

const COLORS = {
  bg: new Color('#f8fafc'),
  bgDark: new Color('#0c0f1a'),
  text: new Color('#0f172a'),
  textDark: new Color('#e2e8f0'),
  textMuted: new Color('#475569'),
  textMutedDark: new Color('#94a3b8'),
  red: new Color('#fee2e2'),
  redText: new Color('#b91c1c'),
  redBorder: new Color('#fca5a5'),
  yellow: new Color('#fef9c3'),
  yellowText: new Color('#a16207'),
  yellowBorder: new Color('#fde047'),
  green: new Color('#dcfce7'),
  greenText: new Color('#15803d'),
  greenBorder: new Color('#86efac'),
  blue: new Color('#6366f1'),
}

// ─── Token Management ───────────────────────────────────────

function getToken() {
  if (Keychain.contains(KEYCHAIN_KEY)) {
    return Keychain.get(KEYCHAIN_KEY)
  }
  if (WIDGET_TOKEN && WIDGET_TOKEN.length > 10) {
    Keychain.set(KEYCHAIN_KEY, WIDGET_TOKEN)
    return WIDGET_TOKEN
  }
  return null
}

function clearToken() {
  if (Keychain.contains(KEYCHAIN_KEY)) {
    Keychain.remove(KEYCHAIN_KEY)
  }
}

// ─── Batch cache (so rotation works between iOS refreshes) ──

function cachePath() {
  const fm = FileManager.local()
  return fm.joinPath(fm.cacheDirectory(), BATCH_CACHE_FILE)
}

function readCachedBatch() {
  try {
    const fm = FileManager.local()
    const p = cachePath()
    if (!fm.fileExists(p)) return null
    const raw = fm.readString(p)
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.fetchedAt || !Array.isArray(parsed.highlights)) return null
    if (Date.now() - parsed.fetchedAt > BATCH_TTL_MS) return null
    if (parsed.date !== todayString()) return null
    return parsed
  } catch {
    return null
  }
}

function writeCachedBatch(payload) {
  try {
    const fm = FileManager.local()
    fm.writeString(cachePath(), JSON.stringify(payload))
  } catch {
    // best-effort
  }
}

// ─── API call ───────────────────────────────────────────────

function todayString() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function fetchWidgetData(token) {
  const today = todayString()
  const url = `${APP_URL}/api/review/widget?token=${encodeURIComponent(token)}&date=${today}&count=${BATCH_SIZE}`

  try {
    const req = new Request(url)
    req.headers = { 'Accept': 'application/json' }
    const res = await req.loadJSON()

    if (res.tokenExpired) {
      clearToken()
      return { tokenExpired: true }
    }

    return res
  } catch (e) {
    return { _debug: `Fetch error: ${e.message || e}` }
  }
}

// Returns { highlights, total, reviewed, allDone } using cache when possible.
async function loadBatch(token) {
  const cached = readCachedBatch()
  if (cached) {
    return {
      highlights: cached.highlights,
      total: cached.total,
      reviewed: cached.reviewed,
      allDone: cached.allDone,
      fromCache: true,
    }
  }

  const data = await fetchWidgetData(token)
  if (!data || data._debug || data.tokenExpired || data.error) {
    return data
  }

  const payload = {
    date: todayString(),
    fetchedAt: Date.now(),
    highlights: Array.isArray(data.highlights)
      ? data.highlights
      : (data.highlight ? [data.highlight] : []),
    total: data.total || 0,
    reviewed: data.reviewed || 0,
    allDone: !!data.allDone,
  }
  writeCachedBatch(payload)
  return { ...payload, fromCache: false }
}

// Pick which highlight to display: rotates per ROTATION_MS slot.
// Deterministic within a slot so successive script runs in the same slot
// show the same item (no flicker), but advances on slot boundaries.
function pickRotationIndex(count) {
  if (count <= 1) return 0
  const slot = Math.floor(Date.now() / ROTATION_MS)
  return ((slot % count) + count) % count
}

// ─── Helpers ────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return ''

  let text = html
  let nestLevel = 0

  text = text.replace(/<(\/?)(?:ul|ol|li)[^>]*>/gi, (match, isClosing) => {
    const tag = match.toLowerCase().match(/<\/?(\w+)/)[1]

    if (tag === 'ul' || tag === 'ol') {
      if (isClosing === '/') {
        nestLevel = Math.max(0, nestLevel - 1)
        return ''
      } else {
        nestLevel++
        return ''
      }
    } else if (tag === 'li') {
      if (isClosing === '/') {
        return '\n'
      } else {
        if (nestLevel > 1) return '  ◦ '
        return '• '
      }
    }
    return ''
  })

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<\/div>/gi, '')

  text = text.replace(/<[^>]*>/g, '')

  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')

  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trim()

  return text
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text
  const truncated = text.substring(0, maxLen - 1)
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace > maxLen * 0.7) {
    return truncated.substring(0, lastSpace) + '…'
  }
  return truncated + '…'
}

// ─── Status widgets (setup / error / done) ──────────────────

function isAccessory(family) {
  return family === 'accessoryRectangular' ||
         family === 'accessoryInline' ||
         family === 'accessoryCircular'
}

function setRefreshHint(widget) {
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_HINT_MS)
}

function makeAccessoryMessage(family, msg) {
  const widget = new ListWidget()
  if (family === 'accessoryInline') {
    const t = widget.addText(msg)
    t.font = Font.systemFont(12)
    return widget
  }
  widget.addSpacer()
  const t = widget.addText(msg)
  t.font = Font.mediumSystemFont(13)
  t.centerAlignText()
  t.lineLimit = 3
  widget.addSpacer()
  return widget
}

// ─── Home Screen widget ─────────────────────────────────────

function renderHomeScreen(widget, family, h, total, reviewed, isDark) {
  widget.backgroundColor = isDark ? COLORS.bgDark : COLORS.bg
  widget.setPadding(20, 20, 20, 20)

  // Header row: title + progress
  const headerStack = widget.addStack()
  headerStack.layoutHorizontally()
  headerStack.centerAlignContent()

  const title = headerStack.addText('Freedwise')
  title.font = Font.boldSystemFont(15)
  title.textColor = COLORS.blue

  headerStack.addSpacer()

  const progress = headerStack.addText(`${reviewed}/${total}`)
  progress.font = Font.mediumSystemFont(13)
  progress.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted

  widget.addSpacer(12)

  const highlightText = stripHtml(h.htmlContent || h.text)

  // Body — limit length and lines per family so layout doesn't blow up
  const limits = family === 'small'
    ? { chars: 220, lines: 8, fontSize: 13 }
    : family === 'medium'
    ? { chars: 380, lines: 7, fontSize: 14 }
    : { chars: 700, lines: 12, fontSize: 17 } // large

  const body = widget.addText(truncate(highlightText, limits.chars))
  body.font = Font.regularSystemFont(limits.fontSize)
  body.textColor = isDark ? COLORS.textDark : COLORS.text
  body.lineLimit = limits.lines

  if (h.source || h.author) {
    widget.addSpacer(8)
    const meta = widget.addText(
      [h.author, h.source].filter(Boolean).join(' · ')
    )
    meta.font = Font.italicSystemFont(12)
    meta.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted
    meta.lineLimit = 1
  }

  widget.addSpacer()

  // Rating buttons — skip on the small family (too cramped for three tap targets).
  if (family !== 'small') {
    addRatingButtons(widget, h, family === 'medium')
  }

  // Fallback tap opens the review page at this highlight
  widget.url = `${APP_URL}/review?id=${h.summaryHighlightId}`
}

function addRatingButtons(parent, h, compact) {
  const rateUrl = (rating) =>
    `${APP_URL}/review?rate=${rating}&id=${h.summaryHighlightId}`

  const padY = compact ? 8 : 12
  const padX = compact ? 16 : 24
  const fontSize = compact ? 14 : 16
  const gap = compact ? 8 : 12

  const btnStack = parent.addStack()
  btnStack.layoutHorizontally()
  btnStack.centerAlignContent()

  btnStack.addSpacer()

  const lowBtn = btnStack.addStack()
  lowBtn.layoutHorizontally()
  lowBtn.centerAlignContent()
  lowBtn.setPadding(padY, padX, padY, padX)
  lowBtn.cornerRadius = 12
  lowBtn.backgroundColor = COLORS.red
  lowBtn.borderColor = COLORS.redBorder
  lowBtn.borderWidth = 2
  lowBtn.url = rateUrl('low')
  const lowLabel = lowBtn.addText('Low')
  lowLabel.font = Font.semiboldSystemFont(fontSize)
  lowLabel.textColor = COLORS.redText
  lowLabel.centerAlignText()

  btnStack.addSpacer(gap)

  const medBtn = btnStack.addStack()
  medBtn.layoutHorizontally()
  medBtn.centerAlignContent()
  medBtn.setPadding(padY, padX, padY, padX)
  medBtn.cornerRadius = 12
  medBtn.backgroundColor = COLORS.yellow
  medBtn.borderColor = COLORS.yellowBorder
  medBtn.borderWidth = 2
  medBtn.url = rateUrl('med')
  const medLabel = medBtn.addText('Med')
  medLabel.font = Font.semiboldSystemFont(fontSize)
  medLabel.textColor = COLORS.yellowText
  medLabel.centerAlignText()

  btnStack.addSpacer(gap)

  const highBtn = btnStack.addStack()
  highBtn.layoutHorizontally()
  highBtn.centerAlignContent()
  highBtn.setPadding(padY, padX, padY, padX)
  highBtn.cornerRadius = 12
  highBtn.backgroundColor = COLORS.green
  highBtn.borderColor = COLORS.greenBorder
  highBtn.borderWidth = 2
  highBtn.url = rateUrl('high')
  const highLabel = highBtn.addText('High')
  highLabel.font = Font.semiboldSystemFont(fontSize)
  highLabel.textColor = COLORS.greenText
  highLabel.centerAlignText()

  btnStack.addSpacer()
}

// ─── Lock Screen accessory widgets ──────────────────────────

function renderAccessoryRectangular(widget, h, total, reviewed) {
  // Lock Screen widgets are monochrome and tiny — keep it minimal.
  widget.setPadding(2, 4, 2, 4)

  const title = widget.addText('Freedwise')
  title.font = Font.boldSystemFont(11)

  const highlightText = stripHtml(h.htmlContent || h.text)
  const body = widget.addText(truncate(highlightText, 110))
  body.font = Font.systemFont(12)
  body.lineLimit = 2

  const footer = widget.addText(`${reviewed}/${total} today`)
  footer.font = Font.systemFont(10)
  footer.textOpacity = 0.7

  widget.url = `${APP_URL}/review?id=${h.summaryHighlightId}`
}

function renderAccessoryInline(widget, h) {
  // Single line of text on the lock screen above the clock.
  const highlightText = stripHtml(h.htmlContent || h.text)
  const t = widget.addText(`📖 ${truncate(highlightText, 60)}`)
  t.font = Font.systemFont(12)
  widget.url = `${APP_URL}/review?id=${h.summaryHighlightId}`
}

function renderAccessoryCircular(widget, total, reviewed) {
  // Small circle — just show progress count.
  widget.setPadding(0, 0, 0, 0)
  const stack = widget.addStack()
  stack.layoutVertically()
  stack.centerAlignContent()

  const label = stack.addText('REVIEW')
  label.font = Font.boldSystemFont(8)
  label.centerAlignText()

  const remaining = Math.max(0, total - reviewed)
  const count = stack.addText(String(remaining))
  count.font = Font.boldSystemFont(20)
  count.centerAlignText()

  widget.url = `${APP_URL}/review`
}

// ─── Setup / error states ───────────────────────────────────

function renderSetupNeeded(family, isDark) {
  if (isAccessory(family)) {
    const w = makeAccessoryMessage(family, 'Tap to set up')
    w.url = `${APP_URL}/widget-auth`
    return w
  }

  const widget = new ListWidget()
  widget.backgroundColor = isDark ? COLORS.bgDark : COLORS.bg
  widget.setPadding(20, 20, 20, 20)
  widget.addSpacer()
  const title = widget.addText('Widget Setup')
  title.font = Font.boldSystemFont(16)
  title.textColor = isDark ? COLORS.textDark : COLORS.text
  title.centerAlignText()
  widget.addSpacer(12)
  const msg = widget.addText('1. Get token from /widget-auth\n2. Paste in script as WIDGET_TOKEN\n3. Run script once (tap Play)\n4. Clear token from script')
  msg.font = Font.systemFont(13)
  msg.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted
  msg.centerAlignText()
  widget.addSpacer()
  widget.url = `${APP_URL}/widget-auth`
  return widget
}

function renderTokenStoredReminder(isDark) {
  const widget = new ListWidget()
  widget.backgroundColor = isDark ? COLORS.bgDark : COLORS.bg
  widget.setPadding(20, 20, 20, 20)
  widget.addSpacer()
  const title = widget.addText('✓ Token Stored Securely')
  title.font = Font.boldSystemFont(18)
  title.textColor = COLORS.blue
  title.centerAlignText()
  widget.addSpacer(12)
  const msg = widget.addText('Now CLEAR the WIDGET_TOKEN from line 28 in your script.\n\nThe token is stored in Keychain and no longer needs to be in the script.')
  msg.font = Font.systemFont(14)
  msg.textColor = isDark ? COLORS.textDark : COLORS.text
  msg.centerAlignText()
  widget.addSpacer()
  return widget
}

function renderError(family, message, url, isDark) {
  if (isAccessory(family)) {
    const w = makeAccessoryMessage(family, 'Tap to open')
    w.url = url || APP_URL
    return w
  }

  const widget = new ListWidget()
  widget.backgroundColor = isDark ? COLORS.bgDark : COLORS.bg
  widget.setPadding(20, 20, 20, 20)
  widget.addSpacer()
  const msg = widget.addText(message)
  msg.font = Font.mediumSystemFont(16)
  msg.textColor = isDark ? COLORS.textDark : COLORS.text
  msg.centerAlignText()
  widget.addSpacer()
  widget.url = url || APP_URL
  return widget
}

function renderAllDone(family, total, reviewed, isDark) {
  if (isAccessory(family)) {
    const w = makeAccessoryMessage(family, `All done · ${reviewed}/${total}`)
    w.url = `${APP_URL}/review`
    return w
  }

  const widget = new ListWidget()
  widget.backgroundColor = isDark ? COLORS.bgDark : COLORS.bg
  widget.setPadding(20, 20, 20, 20)

  const header = widget.addText('Freedwise')
  header.font = Font.boldSystemFont(15)
  header.textColor = COLORS.blue
  header.centerAlignText()

  widget.addSpacer()

  const done = widget.addText('All done for today! 🎉')
  done.font = Font.mediumSystemFont(20)
  done.textColor = isDark ? COLORS.textDark : COLORS.text
  done.centerAlignText()

  widget.addSpacer(8)

  const stats = widget.addText(`${reviewed}/${total} reviewed`)
  stats.font = Font.regularSystemFont(15)
  stats.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted
  stats.centerAlignText()

  widget.addSpacer()
  widget.url = `${APP_URL}/review`
  return widget
}

// ─── Entrypoint ─────────────────────────────────────────────

async function createWidget() {
  const family = config.widgetFamily || 'large'
  const isDark = Device.isUsingDarkAppearance()
  const widget = new ListWidget()
  setRefreshHint(widget)

  const token = getToken()
  if (!token) {
    const w = renderSetupNeeded(family, isDark)
    setRefreshHint(w)
    return w
  }

  if (!config.runsInWidget && WIDGET_TOKEN && WIDGET_TOKEN.length > 10) {
    return renderTokenStoredReminder(isDark)
  }

  const data = await loadBatch(token)

  if (data && data._debug) {
    const w = renderError(family, `Debug: ${data._debug}`, `${APP_URL}/review`, isDark)
    setRefreshHint(w)
    return w
  }

  if (!data) {
    const w = renderError(family, 'Could not load highlights', `${APP_URL}/review`, isDark)
    setRefreshHint(w)
    return w
  }

  if (data.tokenExpired) {
    const w = renderError(family, 'Token revoked.\nGet a new one at /widget-auth', `${APP_URL}/widget-auth`, isDark)
    setRefreshHint(w)
    return w
  }

  if (data.error) {
    const w = renderError(family, 'Could not load highlights', `${APP_URL}/review`, isDark)
    setRefreshHint(w)
    return w
  }

  const highlights = Array.isArray(data.highlights) ? data.highlights : []
  const total = data.total || 0
  const reviewed = data.reviewed || 0

  if (data.allDone || highlights.length === 0) {
    const w = renderAllDone(family, total, reviewed, isDark)
    setRefreshHint(w)
    return w
  }

  const idx = pickRotationIndex(highlights.length)
  const h = highlights[idx]

  if (family === 'accessoryRectangular') {
    renderAccessoryRectangular(widget, h, total, reviewed)
  } else if (family === 'accessoryInline') {
    renderAccessoryInline(widget, h)
  } else if (family === 'accessoryCircular') {
    renderAccessoryCircular(widget, total, reviewed)
  } else {
    renderHomeScreen(widget, family, h, total, reviewed, isDark)
  }

  return widget
}

const widget = await createWidget()

if (config.runsInWidget) {
  Script.setWidget(widget)
} else {
  const family = config.widgetFamily || 'large'
  if (family === 'small') widget.presentSmall()
  else if (family === 'medium') widget.presentMedium()
  else if (family === 'accessoryRectangular' || family === 'accessoryInline' || family === 'accessoryCircular') widget.presentSmall()
  else widget.presentLarge()
}

Script.complete()
