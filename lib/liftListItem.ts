function isListElement(node: Node): node is HTMLElement {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as Element).tagName === 'UL' || (node as Element).tagName === 'OL')
  )
}

/**
 * Pull one list item out of its list and turn it back into a paragraph.
 * Items before it stay in the original list; items after it move into a new
 * list. A nested list inside the item is kept, placed after the paragraph.
 * Returns the block that now holds the item's own text.
 */
export function liftListItem(listItem: HTMLElement): HTMLElement | null {
  const list = listItem.parentElement
  if (!list || !isListElement(list)) return null
  const parent = list.parentNode
  if (!parent) return null

  const after = document.createElement(list.tagName.toLowerCase())
  while (listItem.nextSibling) {
    after.appendChild(listItem.nextSibling)
  }

  const nested: HTMLElement[] = []
  const block = document.createElement('p')
  while (listItem.firstChild) {
    const child = listItem.firstChild
    if (isListElement(child)) {
      nested.push(child)
      listItem.removeChild(child)
    } else {
      block.appendChild(child)
    }
  }

  // Chrome leaves a trailing <br> after a <p> inside an <li>. Drop those so
  // we hoist the paragraph instead of wrapping it in another one.
  while (
    block.childNodes.length > 1 &&
    block.lastChild?.nodeType === Node.ELEMENT_NODE &&
    (block.lastChild as Element).tagName === 'BR'
  ) {
    block.removeChild(block.lastChild)
  }

  let replacement: HTMLElement | null = null
  const onlyChild = block.childNodes.length === 1 ? block.firstChild : null
  if (
    onlyChild?.nodeType === Node.ELEMENT_NODE &&
    ((onlyChild as Element).tagName === 'P' || (onlyChild as Element).tagName === 'DIV')
  ) {
    replacement = onlyChild as HTMLElement
  } else if (block.childNodes.length === 0 && nested.length > 0) {
    replacement = null
  } else {
    if (block.childNodes.length === 0) {
      block.appendChild(document.createElement('br'))
    }
    replacement = block
  }

  listItem.remove()

  const nodes: Node[] = []
  if (replacement) nodes.push(replacement)
  nodes.push(...nested)
  if (Array.from(after.children).some((child) => child.tagName === 'LI')) {
    nodes.push(after)
  }

  const listIsEmpty = !Array.from(list.children).some((child) => child.tagName === 'LI')
  if (listIsEmpty) {
    nodes.forEach((node) => parent.insertBefore(node, list))
    list.remove()
  } else {
    const ref = list.nextSibling
    nodes.forEach((node) => parent.insertBefore(node, ref))
  }

  return replacement
}

/**
 * Switch one list item between bullets and numbers. Sibling items stay in
 * their own list, so only this line changes.
 */
export function changeListItemType(listItem: HTMLElement, tag: 'ul' | 'ol'): HTMLElement | null {
  const list = listItem.parentElement
  if (!list || !isListElement(list)) return null
  if (list.tagName === tag.toUpperCase()) return listItem
  const parent = list.parentNode
  if (!parent) return null

  const after = document.createElement(list.tagName.toLowerCase())
  while (listItem.nextSibling) {
    after.appendChild(listItem.nextSibling)
  }

  const replacement = document.createElement(tag)
  replacement.appendChild(listItem)

  const nodes: Node[] = [replacement]
  if (Array.from(after.children).some((child) => child.tagName === 'LI')) {
    nodes.push(after)
  }

  const listIsEmpty = !Array.from(list.children).some((child) => child.tagName === 'LI')
  if (listIsEmpty) {
    nodes.forEach((node) => parent.insertBefore(node, list))
    list.remove()
  } else {
    const ref = list.nextSibling
    nodes.forEach((node) => parent.insertBefore(node, ref))
  }

  return listItem
}

/** True when a collapsed caret has no text of its own before it in this item. */
export function isCaretAtListItemStart(listItem: HTMLElement, range: Range): boolean {
  if (!range.collapsed || !listItem.contains(range.startContainer)) return false
  const probe = range.cloneRange()
  try {
    probe.setStart(listItem, 0)
    probe.setEnd(range.startContainer, range.startOffset)
  } catch {
    return false
  }
  const fragment = probe.cloneContents()
  fragment.querySelectorAll('ul, ol').forEach((el) => el.remove())
  return (fragment.textContent || '').length === 0
}
