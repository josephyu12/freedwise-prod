import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import RichTextEditor from '@/components/RichTextEditor'
import { changeListItemType, isCaretAtListItemStart, liftListItem } from '@/lib/liftListItem'

function mount(html: string) {
  document.body.innerHTML = `<div id="ed">${html}</div>`
  return document.getElementById('ed') as HTMLDivElement
}

describe('liftListItem', () => {
  it('turns a lone top-level bullet into a paragraph', () => {
    const editor = mount('<ul><li>Hello</li></ul>')
    const block = liftListItem(editor.querySelector('li') as HTMLElement)
    expect(editor.querySelector('ul')).toBeNull()
    expect(block?.tagName).toBe('P')
    expect(block?.textContent).toBe('Hello')
  })

  it('lifts the first item and keeps the rest of the list', () => {
    const editor = mount('<ul><li>First</li><li>Second</li></ul>')
    liftListItem(editor.querySelector('li') as HTMLElement)
    expect(editor.innerHTML).toBe('<p>First</p><ul><li>Second</li></ul>')
  })

  it('splits the list when a middle item is lifted', () => {
    const editor = mount('<ul><li>A</li><li>B</li><li>C</li></ul>')
    liftListItem(editor.querySelectorAll('li')[1] as HTMLElement)
    expect(editor.innerHTML).toBe('<ul><li>A</li></ul><p>B</p><ul><li>C</li></ul>')
  })

  it('hoists a paragraph inside the item and drops the trailing break', () => {
    const editor = mount('<ul><li><p>Hello</p><br></li></ul>')
    liftListItem(editor.querySelector('li') as HTMLElement)
    expect(editor.innerHTML).toBe('<p>Hello</p>')
  })

  it('keeps a nested list after the lifted paragraph', () => {
    const editor = mount('<ul><li>Parent<ul><li>Child</li></ul></li></ul>')
    liftListItem(editor.querySelector('li') as HTMLElement)
    expect(editor.innerHTML).toBe('<p>Parent</p><ul><li>Child</li></ul>')
  })

  it('turns an empty bullet into an empty paragraph', () => {
    const editor = mount('<ul><li><br></li></ul>')
    const block = liftListItem(editor.querySelector('li') as HTMLElement)
    expect(block?.outerHTML).toBe('<p><br></p>')
    expect(editor.querySelector('ul, ol')).toBeNull()
  })
})

function placeCaret(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

describe('RichTextEditor top-level bullets', () => {
  it('removes a top-level bullet when the bullet button is clicked again', () => {
    const { container } = render(
      <RichTextEditor htmlValue="<ul><li>Hello</li></ul>" value="Hello" onChange={vi.fn()} />
    )
    const editor = container.querySelector('[contenteditable]') as HTMLDivElement
    placeCaret(editor.querySelector('li')!.firstChild as Text, 1)

    fireEvent.pointerDown(container.querySelector('button[title="Bullet List"]')!)

    expect(editor.querySelector('ul')).toBeNull()
    expect(editor.textContent).toBe('Hello')
  })

  it('removes a top-level bullet with the outdent button', () => {
    const { container } = render(
      <RichTextEditor htmlValue="<ul><li>Hello</li></ul>" value="Hello" onChange={vi.fn()} />
    )
    const editor = container.querySelector('[contenteditable]') as HTMLDivElement
    placeCaret(editor.querySelector('li')!.firstChild as Text, 0)

    fireEvent.pointerDown(container.querySelector('button[title="Outdent (Shift+Tab)"]')!)

    expect(editor.querySelector('ul')).toBeNull()
    expect(editor.textContent).toBe('Hello')
  })

  it('removes the first top-level bullet with Backspace at the start', () => {
    const { container } = render(
      <RichTextEditor htmlValue="<ul><li>Hello</li></ul>" value="Hello" onChange={vi.fn()} />
    )
    const editor = container.querySelector('[contenteditable]') as HTMLDivElement
    placeCaret(editor.querySelector('li')!.firstChild as Text, 0)

    fireEvent.keyDown(editor, { key: 'Backspace' })

    expect(editor.querySelector('ul')).toBeNull()
    expect(editor.textContent).toBe('Hello')
  })
})

describe('changeListItemType', () => {
  it('switches only the current line and leaves its neighbors', () => {
    const editor = mount('<ul><li>A</li><li>B</li><li>C</li></ul>')
    changeListItemType(editor.querySelectorAll('li')[1] as HTMLElement, 'ol')
    expect(editor.innerHTML).toBe('<ul><li>A</li></ul><ol><li>B</li></ol><ul><li>C</li></ul>')
  })
})

describe('RichTextEditor list toggle', () => {
  it('does not add another bullet on the same line', () => {
    const { container } = render(
      <RichTextEditor
        htmlValue="<ul><li>Parent<ul><li>Child</li></ul></li></ul>"
        value="ParentChild"
        onChange={vi.fn()}
      />
    )
    const editor = container.querySelector('[contenteditable]') as HTMLDivElement
    const child = editor.querySelectorAll('li')[1]
    placeCaret(child.firstChild as Text, 0)

    fireEvent.pointerDown(container.querySelector('button[title="Bullet List"]')!)

    expect(editor.querySelectorAll('li')).toHaveLength(1)
    expect(editor.textContent).toBe('ParentChild')
  })

  it('numbers only the current line', () => {
    const { container } = render(
      <RichTextEditor htmlValue="<ul><li>A</li><li>B</li><li>C</li></ul>" value="ABC" onChange={vi.fn()} />
    )
    const editor = container.querySelector('[contenteditable]') as HTMLDivElement
    placeCaret(editor.querySelectorAll('li')[1].firstChild as Text, 0)

    fireEvent.pointerDown(container.querySelector('button[title="Numbered List"]')!)

    expect(editor.innerHTML).toBe('<ul><li>A</li></ul><ol><li>B</li></ol><ul><li>C</li></ul>')
  })

  it('turns a numbered line back into text when the number button is clicked again', () => {
    const { container } = render(
      <RichTextEditor htmlValue="<ol><li>Hello</li></ol>" value="Hello" onChange={vi.fn()} />
    )
    const editor = container.querySelector('[contenteditable]') as HTMLDivElement
    placeCaret(editor.querySelector('li')!.firstChild as Text, 1)

    fireEvent.pointerDown(container.querySelector('button[title="Numbered List"]')!)

    expect(editor.querySelector('ol')).toBeNull()
    expect(editor.textContent).toBe('Hello')
  })

  it('turns a numbered line into a bullet without adding extra markers', () => {
    const { container } = render(
      <RichTextEditor htmlValue="<ol><li>One</li><li>Two</li></ol>" value="OneTwo" onChange={vi.fn()} />
    )
    const editor = container.querySelector('[contenteditable]') as HTMLDivElement
    placeCaret(editor.querySelectorAll('li')[0].firstChild as Text, 0)

    fireEvent.pointerDown(container.querySelector('button[title="Bullet List"]')!)

    expect(editor.innerHTML).toBe('<ul><li>One</li></ul><ol><li>Two</li></ol>')
  })
})

describe('isCaretAtListItemStart', () => {
  it('is true only at the start of the item text', () => {
    const editor = mount('<ul><li>Hello</li></ul>')
    const li = editor.querySelector('li') as HTMLElement
    const text = li.firstChild as Text
    const range = document.createRange()

    range.setStart(text, 0)
    range.collapse(true)
    expect(isCaretAtListItemStart(li, range)).toBe(true)

    range.setStart(text, 1)
    range.collapse(true)
    expect(isCaretAtListItemStart(li, range)).toBe(false)
  })
})
