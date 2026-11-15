import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import RichTextEditor from '@/components/RichTextEditor'

describe('mobile editor content handoff', () => {
  it('honors a parent clear batched with an input event', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<RichTextEditor value="old draft" htmlValue="<p>old draft</p>" onChange={onChange} />)
    const editor = container.querySelector('[contenteditable]') as HTMLElement
    act(() => {
      editor.innerHTML = '<p>ladder</p>'
      fireEvent.input(editor)
      rerender(<RichTextEditor value="" htmlValue="" onChange={onChange} />)
    })
    expect(editor.textContent).toBe('')
  })

  it('captures final dictation/composition content on blur even without an input event', () => {
    const onChange = vi.fn()
    const { container } = render(<RichTextEditor value="" htmlValue="" onChange={onChange} />)
    const editor = container.querySelector('[contenteditable]') as HTMLElement
    editor.innerHTML = '<p>The ladder of logic</p>'
    fireEvent.blur(editor)
    expect(onChange).toHaveBeenCalledWith('The ladder of logic', '<p>The ladder of logic</p>')
    editor.innerHTML = '<p>Completed composition</p>'
    fireEvent.compositionEnd(editor)
    expect(onChange).toHaveBeenLastCalledWith('Completed composition', '<p>Completed composition</p>')
  })

  it('renders restored HTML through the security sanitizer and plain text as text', () => {
    const { container, rerender } = render(<RichTextEditor value="draft" htmlValue='<p onclick="alert(1)">draft</p><script>bad()</script>' onChange={vi.fn()} />)
    const editor = container.querySelector('[contenteditable]') as HTMLElement
    expect(editor.querySelector('script')).toBeNull()
    expect(editor.innerHTML).not.toContain('onclick')
    rerender(<RichTextEditor value="<a ladder>" htmlValue="" onChange={vi.fn()} />)
    expect(editor.textContent).toBe('<a ladder>')
    expect(editor.querySelector('a')).toBeNull()
  })
})
