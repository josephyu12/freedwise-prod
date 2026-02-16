// Freedwise Quick Review Widget for Scriptable (iOS)
//
// Setup:
// 1. Install "Scriptable" from the App Store
// 2. Create a new script and paste this entire file
// 3. Run the script once IN THE APP (not as widget) — it will open a
//    login page. Sign in, then it stores your credentials securely.
// 4. Add a Medium Scriptable widget to your home screen
// 5. Long-press the widget > Edit Widget > choose this script
//
// The widget shows your next unrated highlight with Low/Med/High buttons.
// Tapping a button opens the Freedwise review page and auto-rates it.
// The widget refreshes every ~15 minutes (iOS-controlled).

// ============ CONFIGURATION ============
const APP_URL = 'https://freedwise.vercel.app'
// =======================================

const KEYCHAIN_KEY = 'freedwise_refresh_token'
const SUPABASE_URL = 'https://kiguewhexyxthomovykj.supabase.co' // Set this too
const SUPABASE_ANON_KEY = 'sb_publishable_6Z509EtXh5_b8aDroCGRYQ_vAx1U2Yw' // Set this too

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

// ─── Auth helpers ───────────────────────────────────────────

async function authenticate() {
  // Try to use stored refresh token first
  if (Keychain.contains(KEYCHAIN_KEY)) {
    const refreshToken = Keychain.get(KEYCHAIN_KEY)
    const tokens = await refreshAccessToken(refreshToken)
    if (tokens) return tokens.access_token
  }

  // No stored token or refresh failed — need interactive login
  if (config.runsInWidget) {
    // Can't do interactive login from widget
    return null
  }

  return await interactiveLogin()
}

async function refreshAccessToken(refreshToken) {
  try {
    const req = new Request(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`)
    req.method = 'POST'
    req.headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    }
    req.body = JSON.stringify({ refresh_token: refreshToken })
    const res = await req.loadJSON()

    if (res.access_token && res.refresh_token) {
      // Store the new refresh token
      Keychain.set(KEYCHAIN_KEY, res.refresh_token)
      return { access_token: res.access_token, refresh_token: res.refresh_token }
    }
    return null
  } catch (e) {
    return null
  }
}

async function interactiveLogin() {
  const wv = new WebView()
  await wv.loadURL(`${APP_URL}/widget-auth`)

  // Let the user interact (log in if needed)
  await wv.present()

  // After the WebView is dismissed, try to read session tokens
  try {
    const result = await wv.evaluateJavaScript(`
      (function() {
        var el = document.getElementById('widget-session');
        return el ? el.textContent : null;
      })()
    `)

    if (result) {
      const tokens = JSON.parse(result)
      if (tokens.refresh_token) {
        Keychain.set(KEYCHAIN_KEY, tokens.refresh_token)
        return tokens.access_token
      }
    }
  } catch (e) {
    // ignore
  }

  return null
}

// ─── API call ───────────────────────────────────────────────

async function fetchNextHighlight(accessToken) {
  const url = `${APP_URL}/api/review/next`
  const req = new Request(url)
  req.headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  }

  try {
    return await req.loadJSON()
  } catch (e) {
    return null
  }
}

// ─── Helpers ────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/g, '\u00B7')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text
  return text.substring(0, maxLen - 1) + '\u2026'
}

// ─── Widget ─────────────────────────────────────────────────

async function createWidget() {
  const widget = new ListWidget()
  const isDark = Device.isUsingDarkAppearance()
  widget.backgroundColor = isDark ? COLORS.bgDark : COLORS.bg
  widget.setPadding(12, 14, 12, 14)

  const accessToken = await authenticate()

  if (!accessToken) {
    const msg = widget.addText('Run script in Scriptable to sign in')
    msg.font = Font.mediumSystemFont(14)
    msg.textColor = isDark ? COLORS.textDark : COLORS.text
    widget.url = `${APP_URL}/review`
    return widget
  }

  const data = await fetchNextHighlight(accessToken)

  if (!data || data.error) {
    // Token might have expired — clear it so next run re-authenticates
    if (Keychain.contains(KEYCHAIN_KEY)) {
      Keychain.remove(KEYCHAIN_KEY)
    }
    const msg = widget.addText('Run script in Scriptable to sign in')
    msg.font = Font.mediumSystemFont(14)
    msg.textColor = isDark ? COLORS.textDark : COLORS.text
    widget.url = `${APP_URL}/review`
    return widget
  }

  // All done state
  if (data.allDone || !data.highlight) {
    const header = widget.addText('Freedwise')
    header.font = Font.boldSystemFont(13)
    header.textColor = COLORS.blue

    widget.addSpacer(8)

    const done = widget.addText('All done for today! \uD83C\uDF89')
    done.font = Font.mediumSystemFont(16)
    done.textColor = isDark ? COLORS.textDark : COLORS.text

    widget.addSpacer(4)

    const stats = widget.addText(`${data.reviewed}/${data.total} reviewed`)
    stats.font = Font.regularSystemFont(12)
    stats.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted

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
  title.font = Font.boldSystemFont(13)
  title.textColor = COLORS.blue

  headerStack.addSpacer()

  const progress = headerStack.addText(`${data.reviewed}/${data.total}`)
  progress.font = Font.mediumSystemFont(11)
  progress.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted

  widget.addSpacer(6)

  // Progress bar
  const barStack = widget.addStack()
  barStack.layoutHorizontally()
  barStack.size = new Size(0, 3)
  barStack.cornerRadius = 2
  barStack.backgroundColor = isDark ? COLORS.progressDark : COLORS.progress

  widget.addSpacer(8)

  // Highlight text
  const displayText = truncate(highlightText, 180)
  const body = widget.addText(displayText)
  body.font = Font.regularSystemFont(14)
  body.textColor = isDark ? COLORS.textDark : COLORS.text
  body.lineLimit = 6

  // Source / author
  if (h.source || h.author) {
    widget.addSpacer(4)
    const meta = widget.addText(
      [h.author, h.source].filter(Boolean).join(' \u00B7 ')
    )
    meta.font = Font.italicSystemFont(11)
    meta.textColor = isDark ? COLORS.textMutedDark : COLORS.textMuted
    meta.lineLimit = 1
  }

  widget.addSpacer()

  // Rating buttons row
  const btnStack = widget.addStack()
  btnStack.layoutHorizontally()
  btnStack.spacing = 8

  const rateUrl = (rating) =>
    `${APP_URL}/review?rate=${rating}&id=${h.summaryHighlightId}`

  // Low button
  const lowBtn = btnStack.addStack()
  lowBtn.layoutHorizontally()
  lowBtn.centerAlignContent()
  lowBtn.setPadding(8, 0, 8, 0)
  lowBtn.cornerRadius = 10
  lowBtn.backgroundColor = COLORS.red
  lowBtn.borderColor = COLORS.redBorder
  lowBtn.borderWidth = 1
  lowBtn.size = new Size(0, 36)
  lowBtn.url = rateUrl('low')
  const lowLabel = lowBtn.addText('  Low  ')
  lowLabel.font = Font.semiboldSystemFont(14)
  lowLabel.textColor = COLORS.redText
  lowLabel.centerAlignText()

  // Med button
  const medBtn = btnStack.addStack()
  medBtn.layoutHorizontally()
  medBtn.centerAlignContent()
  medBtn.setPadding(8, 0, 8, 0)
  medBtn.cornerRadius = 10
  medBtn.backgroundColor = COLORS.yellow
  medBtn.borderColor = COLORS.yellowBorder
  medBtn.borderWidth = 1
  medBtn.size = new Size(0, 36)
  medBtn.url = rateUrl('med')
  const medLabel = medBtn.addText('  Med  ')
  medLabel.font = Font.semiboldSystemFont(14)
  medLabel.textColor = COLORS.yellowText
  medLabel.centerAlignText()

  // High button
  const highBtn = btnStack.addStack()
  highBtn.layoutHorizontally()
  highBtn.centerAlignContent()
  highBtn.setPadding(8, 0, 8, 0)
  highBtn.cornerRadius = 10
  highBtn.backgroundColor = COLORS.green
  highBtn.borderColor = COLORS.greenBorder
  highBtn.borderWidth = 1
  highBtn.size = new Size(0, 36)
  highBtn.url = rateUrl('high')
  const highLabel = highBtn.addText('  High  ')
  highLabel.font = Font.semiboldSystemFont(14)
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
  // Preview in Scriptable app
  widget.presentMedium()
}

Script.complete()
