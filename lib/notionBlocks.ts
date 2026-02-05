/**
 * Shared HTML → Notion block conversion.
 * Used by update, add, and sync routes so bullets/paragraphs/strikethrough
 * render consistently and without duplication.
 */

export function htmlToNotionRichText(html: string): any[] {
  if (!html || html.trim() === '') {
    return []
  }

  function decodeHtmlEntities(text: string): string {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&#x60;/g, '`')
      .replace(/&#x3D;/g, '=')
  }

  interface TextSegment {
    text: string
    bold: boolean
    italic: boolean
    underline: boolean
    strikethrough: boolean
    code: boolean
    link?: string
  }

  const segments: TextSegment[] = []
  let currentSegment: TextSegment = {
    text: '',
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    code: false,
  }

  const boldStack: boolean[] = []
  const italicStack: boolean[] = []
  const underlineStack: boolean[] = []
  const strikethroughStack: boolean[] = []
  const codeStack: boolean[] = []
  let currentLink: string | null = null

  let i = 0
  while (i < html.length) {
    if (html[i] === '<') {
      const tagEnd = html.indexOf('>', i)
      if (tagEnd === -1) {
        currentSegment.text += html[i]
        i++
        continue
      }
      const tag = html.substring(i, tagEnd + 1)
      const tagNameMatch = tag.match(/<\/?(\w+)/i)
      if (!tagNameMatch) {
        i = tagEnd + 1
        continue
      }
      const tagName = tagNameMatch[1].toLowerCase()
      const isClosing = tag.startsWith('</')
      if (tagName === 'strong' || tagName === 'b') {
        if (isClosing) boldStack.pop()
        else boldStack.push(true)
      } else if (tagName === 'em' || tagName === 'i') {
        if (isClosing) italicStack.pop()
        else italicStack.push(true)
      } else if (tagName === 'u') {
        if (isClosing) underlineStack.pop()
        else underlineStack.push(true)
      } else if (tagName === 's' || tagName === 'strike' || tagName === 'del') {
        if (isClosing) strikethroughStack.pop()
        else strikethroughStack.push(true)
      } else if (tagName === 'code') {
        if (isClosing) codeStack.pop()
        else codeStack.push(true)
      } else if (tagName === 'a') {
        if (isClosing) currentLink = null
        else {
          const hrefMatch = tag.match(/href=["']([^"']+)["']/i)
          if (hrefMatch) currentLink = hrefMatch[1]
        }
      } else if (tagName === 'br') {
        currentSegment.text += '\n'
      }
      i = tagEnd + 1
    } else {
      const newFormatting = {
        bold: boldStack.length > 0,
        italic: italicStack.length > 0,
        underline: underlineStack.length > 0,
        strikethrough: strikethroughStack.length > 0,
        code: codeStack.length > 0,
      }
      const formattingChanged =
        currentSegment.bold !== newFormatting.bold ||
        currentSegment.italic !== newFormatting.italic ||
        currentSegment.underline !== newFormatting.underline ||
        currentSegment.strikethrough !== newFormatting.strikethrough ||
        currentSegment.code !== newFormatting.code ||
        (currentLink !== null && currentSegment.link !== currentLink) ||
        (currentLink === null && currentSegment.link !== undefined)
      if (formattingChanged && currentSegment.text) {
        segments.push({ ...currentSegment, link: currentLink || undefined })
        currentSegment = {
          text: '',
          bold: newFormatting.bold,
          italic: newFormatting.italic,
          underline: newFormatting.underline,
          strikethrough: newFormatting.strikethrough,
          code: newFormatting.code,
        }
      } else {
        currentSegment.bold = newFormatting.bold
        currentSegment.italic = newFormatting.italic
        currentSegment.underline = newFormatting.underline
        currentSegment.strikethrough = newFormatting.strikethrough
        currentSegment.code = newFormatting.code
      }
      currentSegment.text += html[i]
      i++
    }
  }
  if (currentSegment.text) {
    segments.push({ ...currentSegment, link: currentLink || undefined })
  }

  const richText: any[] = []
  for (let j = 0; j < segments.length; j++) {
    const segment = segments[j]
    let decodedText = decodeHtmlEntities(segment.text)
    if (j === 0) decodedText = decodedText.replace(/^\s+/, '')
    if (j === segments.length - 1) decodedText = decodedText.replace(/\s+$/, '')
    if (!decodedText.trim() && decodedText.length === 0) continue
    richText.push({
      type: 'text',
      text: segment.link ? { content: decodedText, link: { url: segment.link } } : { content: decodedText },
      annotations: {
        bold: segment.bold,
        italic: segment.italic,
        strikethrough: segment.strikethrough,
        underline: segment.underline,
        code: segment.code,
        color: 'default',
      },
      plain_text: decodedText,
    })
  }
  if (richText.length === 0) {
    const plainText = html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim()
    if (plainText) {
      richText.push({
        type: 'text',
        text: { content: plainText },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default',
        },
        plain_text: plainText,
      })
    }
  }
  return richText.length > 0 ? richText : []
}

function parseListItem(liHtml: string): { text: string; nestedLists: Array<{ type: 'ul' | 'ol'; content: string }> } {
  const nestedLists: Array<{ type: 'ul' | 'ol'; content: string }> = []
  let text = liHtml
  const nestedUlRegex = /<ul[^>]*>(.*?)<\/ul>/gis
  const nestedOlRegex = /<ol[^>]*>(.*?)<\/ol>/gis
  const ulMatches: Array<{ start: number; end: number; content: string }> = []
  let match
  while ((match = nestedUlRegex.exec(liHtml)) !== null) {
    ulMatches.push({ start: match.index, end: match.index + match[0].length, content: match[1] })
  }
  const olMatches: Array<{ start: number; end: number; content: string }> = []
  while ((match = nestedOlRegex.exec(liHtml)) !== null) {
    olMatches.push({ start: match.index, end: match.index + match[0].length, content: match[1] })
  }
  const allMatches = [
    ...ulMatches.map((m) => ({ ...m, type: 'ul' as const })),
    ...olMatches.map((m) => ({ ...m, type: 'ol' as const })),
  ].sort((a, b) => a.start - b.start)
  let offset = 0
  for (const m of allMatches) {
    nestedLists.push({ type: m.type, content: m.content })
    const before = text.substring(0, m.start - offset)
    const after = text.substring(m.end - offset)
    text = before + after
    offset += m.end - m.start
  }
  return { text: text.trim(), nestedLists }
}

function processListItems(listContent: string, listType: 'ul' | 'ol', blocks: any[]): void {
  let pos = 0
  const liStartRegex = /<li[^>]*>/gi
  while (pos < listContent.length) {
    const remaining = listContent.substring(pos)
    const liStartMatch = liStartRegex.exec(remaining)
    if (!liStartMatch) break
    const liStartPos = pos + liStartMatch.index + liStartMatch[0].length
    let depth = 0
    let liEndPos = liStartPos
    let found = false
    for (let i = liStartPos; i < listContent.length; i++) {
      if (listContent.substring(i).startsWith('<li')) {
        depth++
        i += 2
      } else if (listContent.substring(i).startsWith('</li>')) {
        if (depth === 0) {
          liEndPos = i
          found = true
          break
        }
        depth--
        i += 4
      }
    }
    if (!found) break
    const liContent = listContent.substring(liStartPos, liEndPos)
    const { text, nestedLists } = parseListItem(liContent)
    const richText = htmlToNotionRichText(text)
    const listItemType = listType === 'ul' ? 'bulleted_list_item' : 'numbered_list_item'
    const listItemBlock: any = {
      type: listItemType,
      [listItemType]: { rich_text: richText.length > 0 ? richText : [] },
    }
    if (nestedLists.length > 0) {
      const children: any[] = []
      for (const nested of nestedLists) {
        processListItems(nested.content, nested.type, children)
      }
      if (children.length > 0) {
        listItemBlock[listItemType].children = children
      }
    }
    if (richText.length > 0 || (listItemBlock[listItemType].children?.length > 0)) {
      blocks.push(listItemBlock)
    }
    pos = liEndPos + 5
    liStartRegex.lastIndex = 0
  }
}

/** True if content is only whitespace and a single top-level <ul>...</ul> or <ol>...</ol>. */
function isOnlyTopLevelList(html: string): boolean {
  const t = html.trim()
  if (!t) return false
  const open = t.startsWith('<ul') ? 'ul' : t.startsWith('<ol') ? 'ol' : null
  if (!open) return false
  const openTag = '<' + open
  const closeTag = '</' + open + '>'
  let depth = 1
  let i = t.indexOf('>') + 1
  while (i < t.length && depth > 0) {
    if (t.substring(i).startsWith(openTag)) {
      depth++
      i += openTag.length
    } else if (t.substring(i).startsWith(closeTag)) {
      depth--
      i += closeTag.length
    } else {
      i++
    }
  }
  return depth === 0 && t.substring(i).trim() === ''
}

function findTopLevelLists(html: string, tag: 'ul' | 'ol'): Array<{ index: number; content: string; fullMatch: string }> {
  const results: Array<{ index: number; content: string; fullMatch: string }> = []
  const openTag = `<${tag}`
  const closeTag = `</${tag}>`
  let pos = 0
  while (pos < html.length) {
    const openIndex = html.indexOf(openTag, pos)
    if (openIndex === -1) break
    const tagEndIndex = html.indexOf('>', openIndex)
    if (tagEndIndex === -1) break
    let depth = 1
    const contentStart = tagEndIndex + 1
    let found = false
    for (let i = contentStart; i < html.length; i++) {
      if (html.substring(i).startsWith(openTag)) {
        depth++
        i += openTag.length - 1
      } else if (html.substring(i).startsWith(closeTag)) {
        depth--
        if (depth === 0) {
          const content = html.substring(contentStart, i)
          const fullMatch = html.substring(openIndex, i + closeTag.length)
          results.push({ index: openIndex, content, fullMatch })
          pos = i + closeTag.length
          found = true
          break
        }
        i += closeTag.length - 1
      }
    }
    if (!found) break
  }
  return results
}

export function htmlToNotionBlocks(html: string): any[] {
  if (!html || html.trim() === '') {
    return [{ type: 'paragraph', paragraph: { rich_text: [] } }]
  }

  const blocks: any[] = []
  interface ContentBlock {
    index: number
    type: 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre' | 'p' | 'div' | 'text'
    content: string
    fullMatch: string
  }
  const contentBlocks: ContentBlock[] = []

  for (const ul of findTopLevelLists(html, 'ul')) {
    contentBlocks.push({ index: ul.index, type: 'ul', content: ul.content, fullMatch: ul.fullMatch })
  }
  for (const ol of findTopLevelLists(html, 'ol')) {
    contentBlocks.push({ index: ol.index, type: 'ol', content: ol.content, fullMatch: ol.fullMatch })
  }

  const h1Regex = /<h1[^>]*>(.*?)<\/h1>/gi
  let h1Match
  while ((h1Match = h1Regex.exec(html)) !== null) {
    contentBlocks.push({ index: h1Match.index, type: 'h1', content: h1Match[1], fullMatch: h1Match[0] })
  }
  const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi
  let h2Match
  while ((h2Match = h2Regex.exec(html)) !== null) {
    contentBlocks.push({ index: h2Match.index, type: 'h2', content: h2Match[1], fullMatch: h2Match[0] })
  }
  const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gi
  let h3Match
  while ((h3Match = h3Regex.exec(html)) !== null) {
    contentBlocks.push({ index: h3Match.index, type: 'h3', content: h3Match[1], fullMatch: h3Match[0] })
  }
  const blockquoteRegex = /<blockquote[^>]*>(.*?)<\/blockquote>/gi
  let blockquoteMatch
  while ((blockquoteMatch = blockquoteRegex.exec(html)) !== null) {
    contentBlocks.push({
      index: blockquoteMatch.index,
      type: 'blockquote',
      content: blockquoteMatch[1],
      fullMatch: blockquoteMatch[0],
    })
  }
  const preRegex = /<pre[^>]*>(.*?)<\/pre>/gis
  let preMatch
  while ((preMatch = preRegex.exec(html)) !== null) {
    contentBlocks.push({ index: preMatch.index, type: 'pre', content: preMatch[1], fullMatch: preMatch[0] })
  }
  const pRegex = /<p[^>]*>(.*?)<\/p>/gi
  let pMatch
  while ((pMatch = pRegex.exec(html)) !== null) {
    contentBlocks.push({ index: pMatch.index, type: 'p', content: pMatch[1], fullMatch: pMatch[0] })
  }
  const divRegex = /<div[^>]*>(.*?)<\/div>/gi
  let divMatch
  while ((divMatch = divRegex.exec(html)) !== null) {
    contentBlocks.push({
      index: divMatch.index,
      type: 'div',
      content: divMatch[1],
      fullMatch: divMatch[0],
    })
  }

  contentBlocks.sort((a, b) => a.index - b.index)

  let lastIndex = 0
  for (const block of contentBlocks) {
    if (block.index > lastIndex) {
      const textBefore = html.substring(lastIndex, block.index).trim()
      if (textBefore) {
        const richText = htmlToNotionRichText(textBefore)
        if (richText.length > 0) {
          blocks.push({ type: 'paragraph', paragraph: { rich_text: richText } })
        }
      }
    }

    switch (block.type) {
      case 'ul':
        processListItems(block.content, 'ul', blocks)
        break
      case 'ol':
        processListItems(block.content, 'ol', blocks)
        break
      case 'h1': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0) {
          blocks.push({ type: 'heading_1', heading_1: { rich_text: richText } })
        }
        break
      }
      case 'h2': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0) {
          blocks.push({ type: 'heading_2', heading_2: { rich_text: richText } })
        }
        break
      }
      case 'h3': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0) {
          blocks.push({ type: 'heading_3', heading_3: { rich_text: richText } })
        }
        break
      }
      case 'blockquote': {
        const richText = htmlToNotionRichText(block.content)
        if (richText.length > 0) {
          blocks.push({ type: 'quote', quote: { rich_text: richText } })
        }
        break
      }
      case 'pre': {
        const code = block.content.replace(/<[^>]*>/g, '').trim()
        if (code) {
          blocks.push({
            type: 'code',
            code: {
              rich_text: [{
                type: 'text',
                text: { content: code },
                annotations: {
                  bold: false,
                  italic: false,
                  strikethrough: false,
                  underline: false,
                  code: false,
                  color: 'default',
                },
                plain_text: code,
              }],
              language: 'plain text',
            },
          })
        }
        break
      }
      case 'p':
      case 'div': {
        // Skip if this block is only a list (avoids duplicate bullets + paragraph)
        if (isOnlyTopLevelList(block.content)) break
        // Split by <br> or by adjacent block tags so "Line 1" + Enter + "Line 2" => 2 Notion paragraphs
        const lineParts = block.content.split(/(?:<\s*br\s*\/?\s*>|<\/div>\s*<div[^>]*>|<\/p>\s*<p[^>]*>)/gi)
        for (const part of lineParts) {
          const richText = htmlToNotionRichText(part)
          if (richText.length > 0 || part.trim() === '') {
            blocks.push({ type: 'paragraph', paragraph: { rich_text: richText } })
          }
        }
        break
      }
    }

    lastIndex = block.index + block.fullMatch.length
  }

  if (lastIndex < html.length) {
    const textAfter = html.substring(lastIndex).trim()
    if (textAfter) {
      // Split by <br> or newlines so plain "Line 1\nLine 2" (e.g. from queue text-only) => 2 paragraphs
      const lineParts = textAfter.split(/(?:<\s*br\s*\/?\s*>|<\/div>\s*<div[^>]*>|\n)/gi)
      for (const part of lineParts) {
        const trimmed = part.trim()
        const richText = htmlToNotionRichText(trimmed || part)
        if (richText.length > 0 || (trimmed || part) === '') {
          blocks.push({ type: 'paragraph', paragraph: { rich_text: richText } })
        }
      }
    }
  }

  if (blocks.length === 0) {
    const lineParts = html.split(/(?:<\s*br\s*\/?\s*>|<\/div>\s*<div[^>]*>|\n)/gi)
    for (const part of lineParts) {
      const stripped = part.replace(/^<div[^>]*>/i, '').replace(/<\/div>$/i, '').trim()
      const richText = htmlToNotionRichText(stripped || part)
      if (richText.length > 0 || (stripped || part).trim() === '') {
        blocks.push({ type: 'paragraph', paragraph: { rich_text: richText } })
      }
    }
  }
  if (blocks.length === 0) {
    const plainText = html.replace(/<[^>]*>/g, '').trim()
    if (plainText) {
      const richText = htmlToNotionRichText(html)
      blocks.push({ type: 'paragraph', paragraph: { rich_text: richText } })
    }
  }
  if (blocks.length === 0) {
    return [{ type: 'paragraph', paragraph: { rich_text: htmlToNotionRichText(html) } }]
  }
  return blocks
}
