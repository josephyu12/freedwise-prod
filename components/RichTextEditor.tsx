'use client'

import { useRef, useState, useEffect } from 'react'

interface RichTextEditorProps {
  value: string
  htmlValue?: string
  onChange: (text: string, html: string) => void
  placeholder?: string
}

export default function RichTextEditor({ value, htmlValue, onChange, placeholder }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [isFocused, setIsFocused] = useState(false)

  useEffect(() => {
    if (editorRef.current && htmlValue !== undefined) {
      editorRef.current.innerHTML = htmlValue || value || ''
    } else if (editorRef.current && !htmlValue && value) {
      editorRef.current.textContent = value
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run on mount to set initial value

  const handleInput = () => {
    if (editorRef.current) {
      const html = editorRef.current.innerHTML
      const text = editorRef.current.textContent || ''
      onChange(text, html)
    }
  }

  const execCommand = (command: string, value?: string) => {
    if (!editorRef.current) return
    
    editorRef.current.focus()
    
    // For list commands, use a more reliable approach
    if (command === 'insertUnorderedList') {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        const container = range.commonAncestorContainer
        
        // Check if we're already in a list
        const listElement = container.nodeType === Node.ELEMENT_NODE
          ? (container as Element).closest('ul, ol')
          : container.parentElement?.closest('ul, ol')
        
        if (listElement) {
          // Toggle off if already in a list
          document.execCommand('insertUnorderedList', false)
          document.execCommand('insertOrderedList', false)
        } else {
          // Create new list
          const success = document.execCommand('insertUnorderedList', false)
          if (!success) {
            // Fallback: manually create list
            const text = selection.toString() || 'List item'
            const ul = document.createElement('ul')
            const li = document.createElement('li')
            li.textContent = text
            ul.appendChild(li)
            range.deleteContents()
            range.insertNode(ul)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      } else {
        // No selection, create list at cursor
        document.execCommand('insertUnorderedList', false)
      }
    } else if (command === 'insertOrderedList') {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        const container = range.commonAncestorContainer
        
        // Check if we're already in a list
        const listElement = container.nodeType === Node.ELEMENT_NODE
          ? (container as Element).closest('ul, ol')
          : container.parentElement?.closest('ul, ol')
        
        if (listElement) {
          // Toggle off if already in a list
          document.execCommand('insertUnorderedList', false)
          document.execCommand('insertOrderedList', false)
        } else {
          // Create new list
          const success = document.execCommand('insertOrderedList', false)
          if (!success) {
            // Fallback: manually create list
            const text = selection.toString() || 'List item'
            const ol = document.createElement('ol')
            const li = document.createElement('li')
            li.textContent = text
            ol.appendChild(li)
            range.deleteContents()
            range.insertNode(ol)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      } else {
        // No selection, create list at cursor
        document.execCommand('insertOrderedList', false)
      }
    } else {
      // For other commands, use standard execCommand
      document.execCommand(command, false, value)
    }
    
    handleInput()
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
    handleInput()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Enter key in lists
    if (e.key === 'Enter' && editorRef.current) {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        const container = range.commonAncestorContainer
        const listElement = container.nodeType === Node.ELEMENT_NODE
          ? (container as Element).closest('ul, ol')
          : container.parentElement?.closest('ul, ol')
        
        if (listElement && e.shiftKey) {
          // Shift+Enter: exit list
          e.preventDefault()
          const br = document.createElement('br')
          range.deleteContents()
          range.insertNode(br)
          range.setStartAfter(br)
          selection.removeAllRanges()
          selection.addRange(range)
          handleInput()
        }
        // Normal Enter in list will create new list item (browser default)
      }
    }
  }

  return (
    <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent">
      <div className="flex gap-1 p-2 bg-gray-50 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
        <button
          type="button"
          onClick={() => execCommand('bold')}
          className="px-3 py-1 text-sm font-bold bg-white dark:bg-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-500 transition"
          title="Bold"
        >
          B
        </button>
        <button
          type="button"
          onClick={() => execCommand('italic')}
          className="px-3 py-1 text-sm italic bg-white dark:bg-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-500 transition"
          title="Italic"
        >
          I
        </button>
        <button
          type="button"
          onClick={() => execCommand('underline')}
          className="px-3 py-1 text-sm underline bg-white dark:bg-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-500 transition"
          title="Underline"
        >
          U
        </button>
        <div className="w-px bg-gray-300 dark:bg-gray-600 mx-1" />
        <button
          type="button"
          onClick={() => execCommand('insertUnorderedList')}
          className="px-3 py-1 text-sm bg-white dark:bg-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-500 transition"
          title="Bullet List"
        >
          •
        </button>
        <button
          type="button"
          onClick={() => execCommand('insertOrderedList')}
          className="px-3 py-1 text-sm bg-white dark:bg-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-500 transition"
          title="Numbered List"
        >
          1.
        </button>
      </div>
      <div
        ref={editorRef}
        contentEditable
        onInput={handleInput}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        className="min-h-[120px] px-4 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200 focus:outline-none rich-text-editor"
        style={{ whiteSpace: 'pre-wrap' }}
        data-placeholder={placeholder}
        suppressContentEditableWarning
      />
    </div>
  )
}

