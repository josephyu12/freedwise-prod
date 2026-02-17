// Freedwise Quick Review Widget for Scriptable (iOS)
//
// Setup:
// 1. Install "Scriptable" from the App Store
// 2. Create a new script and paste this entire file
// 3. Open freedwise.vercel.app/widget-auth in Safari to get your token
// 4. Paste the token below as WIDGET_TOKEN (temporarily)
// 5. Run the script ONCE by tapping the Play button (not as widget)
// 6. After seeing "Token stored securely", CLEAR the token from line 18 below
// 7. Add a Large Scriptable widget to your home screen
// 8. Long-press the widget > Edit Widget > choose this script
//
// The widget shows your next unrated highlight with Low/Med/High buttons.
// To revoke access, go to Settings in the Freedwise app.

// ============ CONFIGURATION ============
const APP_URL = 'https://freedwise.vercel.app'
const WIDGET_TOKEN = '' // <-- Paste token here temporarily, then CLEAR after first run
// =======================================

const KEYCHAIN_KEY = 'freedwise_widget_token'

const COLORS = {
  bg: new Color('#f0f4ff'),
  bgDark: new Color('#1a1a2e'),
  text: new Color('#1f2937'),
  textDark: new Color('#e5e7eb'),
  textMuted: new Color('#6b7280'),
  textMutedDark: new Color('#9ca3af'),
  red: new Color('#fee2e2'),
  redText: new Color('#b91c1c'),
  redBorder: new Color('#fca5a5'),
  yellow: new Color('#fef9c3'),
  yellowText: new Color('#a16207'),
  yellowBorder: new Color('#fde047'),
  green: new Color('#dcfce7'),
  greenText: new Color('#15803d'),
  greenBorder: new Color('#86efac'),
  blue: new Color('#3b82f6'),
  progress: new Color('#e5e7eb'),
  progressDark: new Color('#374151'),
}

// ─── Token Management ───────────────────────────────────────

function getToken() {
  // First check Keychain
  if (Keychain.contains(KEYCHAIN_KEY)) {
    return Keychain.get(KEYCHAIN_KEY)
  }

  // If token is pasted in script, move it to Keychain
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

// ─── API call ───────────────────────────────────────────────

async function fetchWidgetData(token) {
  // Get today's date in local timezone
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const today = `${year}-${month}-${day}`

  const url = `${APP_URL}/api/review/widget?token=${encodeURIComponent(token)}&date=${today}`

  try {
    const req = new Request(url)
    req.headers = { 'Accept': 'application/json' }
    const res = await req.loadJSON()

    if (res.tokenExpired) {
      // Token was revoked - clear from Keychain
      clearToken()
      return { tokenExpired: true }
    }

    return res
  } catch (e) {
    return { _debug: `Fetch error: ${e.message || e}` }
  }
}

// ─── Helpers ────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return ''

  let text = html
  let nestLevel = 0

  // Process HTML in a single pass, tracking nesting as we go
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
        // Add bullet based on current nesting level (no leading newline)
        if (nestLevel > 1) return '  ◦ ' // Nested bullet with indent
        return '• ' // Top-level bullet
      }
    }
    return ''
  })

  // Handle other block elements
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<\/div>/gi, '')

  // Remove remaining HTML tags
  text = text.replace(/<[^>]*>/g, '')

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')

  // Clean up whitespace
  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '') // Remove leading newlines
    .trim()

  return text
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text
  // Find last complete word within limit
  const truncated = text.substring(0, maxLen - 1)
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace > maxLen * 0.7) {
    return truncated.substring(0, lastSpace) + '…'
  }
  return truncated + '…'
}

// ─── Widget ─────────────────────────────────────────────────

async function createWidget() {
  const widget = new ListWidget()
  const isDark = Device.isUsingDarkAppearance()
  widget.backgroundColor = isDark ? COLORS.bgDark : COLORS.bg
  widget.setPadding(20, 20, 20, 20)

  const token = getToken()

  // Show setup instructions if no token
  if (!token) {
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

  // If running manually (not as widget) and token is still in script, show reminder
  if (!config.runsInWidget && WIDGET_TOKEN && WIDGET_TOKEN.length > 10) {
    widget.addSpacer()
    const title = widget.addText('✓ Token Stored Securely')
    title.font = Font.boldSystemFont(18)
    title.textColor = COLORS.blue
    title.centerAlignText()
    widget.addSpacer(12)

    const msg = widget.addText('Now CLEAR the WIDGET_TOKEN from line 18 in your script.\n\nThe token is stored in Keychain and no longer needs to be in the script.')
    msg.font = Font.systemFont(14)
    msg.textColor = isDark ? COLORS.textDark : COLORS.text
    msg.centerAlignText()
    widget.addSpacer()
    return widget
  }

  const data = await fetchWidgetData(token)

  // Debug: show raw response info
  if (data && data._debug) {
    widget.addSpacer()
    const msg = widget.addText(`Debug: ${data._debug}`)
    msg.font = Font.mediumSystemFont(13)
    msg.textColor = isDark ? COLORS.textDark : COLORS.text
    msg.centerAlignText()
    widget.addSpacer()
    widget.url = `${APP_URL}/review`
    return widget
  }

  if (!data) {
    widget.addSpacer()
    const msg = widget.addText('Could not load highlights')
    msg.font = Font.mediumSystemFont(16)
    msg.textColor = isDark ? COLORS.textDark : COLORS.text
    msg.centerAlignText()
    widget.addSpacer()
    widget.url = `${APP_URL}/review`
    return widget
  }

  if (data.tokenExpired) {
    widget.addSpacer()
    const msg = widget.addText('Token revoked.\nGet a new one at /widget-auth')
    msg.font = Font.mediumSystemFont(15)
    msg.textColor = isDark ? COLORS.textDark : COLORS.text
    msg.centerAlignText()
    widget.addSpacer()
    widget.url = `${APP_URL}/widget-auth`
    return widget
  }

  if (data.error) {
    widget.addSpacer()
    const msg = widget.addText('Could not load highlights')
    msg.font = Font.mediumSystemFont(16)
    msg.textColor = isDark ? COLORS.textDark : COLORS.text
    msg.centerAlignText()
    widget.addSpacer()
    widget.url = `${APP_URL}/review`
    return widget
  }

  // All done state
  if (data.allDone || !data.highlight) {
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

    const stats = widget.addText(`${data.reviewed}/${data.total} reviewed`)
    stats.font = Font.regularSystemFont(15)
    stats.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted
    stats.centerAlignText()

    widget.addSpacer()

    widget.url = `${APP_URL}/review`
    return widget
  }

  const h = data.highlight
  const highlightText = stripHtml(h.htmlContent || h.text)

  // Header row: title + progress
  const headerStack = widget.addStack()
  headerStack.layoutHorizontally()
  headerStack.centerAlignContent()

  const title = headerStack.addText('Freedwise')
  title.font = Font.boldSystemFont(15)
  title.textColor = COLORS.blue

  headerStack.addSpacer()

  const progress = headerStack.addText(`${data.reviewed}/${data.total}`)
  progress.font = Font.mediumSystemFont(13)
  progress.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted

  widget.addSpacer(12)

  // Highlight text - allow more lines, better wrapping
  const body = widget.addText(highlightText)
  body.font = Font.regularSystemFont(17)
  body.textColor = isDark ? COLORS.textDark : COLORS.text
  body.lineLimit = 12

  // Source / author
  if (h.source || h.author) {
    widget.addSpacer(8)
    const meta = widget.addText(
      [h.author, h.source].filter(Boolean).join(' · ')
    )
    meta.font = Font.italicSystemFont(13)
    meta.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted
    meta.lineLimit = 1
  }

  widget.addSpacer()

  // Rating buttons row - centered
  const btnStack = widget.addStack()
  btnStack.layoutHorizontally()
  btnStack.spacing = 12
  btnStack.centerAlignContent()

  const rateUrl = (rating) =>
    `${APP_URL}/review?rate=${rating}&id=${h.summaryHighlightId}`

  // Low button
  const lowBtn = btnStack.addStack()
  lowBtn.layoutHorizontally()
  lowBtn.centerAlignContent()
  lowBtn.setPadding(12, 24, 12, 24)
  lowBtn.cornerRadius = 12
  lowBtn.backgroundColor = COLORS.red
  lowBtn.borderColor = COLORS.redBorder
  lowBtn.borderWidth = 2
  lowBtn.url = rateUrl('low')
  const lowLabel = lowBtn.addText('Low')
  lowLabel.font = Font.semiboldSystemFont(16)
  lowLabel.textColor = COLORS.redText
  lowLabel.centerAlignText()

  // Med button
  const medBtn = btnStack.addStack()
  medBtn.layoutHorizontally()
  medBtn.centerAlignContent()
  medBtn.setPadding(12, 24, 12, 24)
  medBtn.cornerRadius = 12
  medBtn.backgroundColor = COLORS.yellow
  medBtn.borderColor = COLORS.yellowBorder
  medBtn.borderWidth = 2
  medBtn.url = rateUrl('med')
  const medLabel = medBtn.addText('Med')
  medLabel.font = Font.semiboldSystemFont(16)
  medLabel.textColor = COLORS.yellowText
  medLabel.centerAlignText()

  // High button
  const highBtn = btnStack.addStack()
  highBtn.layoutHorizontally()
  highBtn.centerAlignContent()
  highBtn.setPadding(12, 24, 12, 24)
  highBtn.cornerRadius = 12
  highBtn.backgroundColor = COLORS.green
  highBtn.borderColor = COLORS.greenBorder
  highBtn.borderWidth = 2
  highBtn.url = rateUrl('high')
  const highLabel = highBtn.addText('High')
  highLabel.font = Font.semiboldSystemFont(16)
  highLabel.textColor = COLORS.greenText
  highLabel.centerAlignText()

  // Fallback tap opens review page
  widget.url = `${APP_URL}/review`

  return widget
}

const widget = await createWidget()

if (config.runsInWidget) {
  Script.setWidget(widget)
} else {
  widget.presentLarge()
}

Script.complete()
