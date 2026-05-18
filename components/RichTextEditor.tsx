'use client'

import { useRef, useState, useEffect } from 'react'
import { sanitizeHtml } from '@/lib/sanitizeHtml'

interface RichTextEditorProps {
  value: string
  htmlValue?: string
  onChange: (text: string, html: string) => void
  placeholder?: string
  fullscreen?: boolean
  onToggleFullscreen?: () => void
}

export default function RichTextEditor({ value, htmlValue, onChange, placeholder, fullscreen, onToggleFullscreen }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const isInternalUpdate = useRef(false)
  const savedSelection = useRef<Range | null>(null)
  const [isFocused, setIsFocused] = useState(false)

  // Track selection changes so we can restore it after toolbar button taps on mobile
  // (on iOS, tapping a button causes contentEditable to blur and lose its selection)
  useEffect(() => {
    const handleSelectionChange = () => {
      const sel = window.getSelection()
      if (
        sel &&
        sel.rangeCount > 0 &&
        editorRef.current &&
        editorRef.current.contains(sel.anchorNode)
      ) {
        savedSelection.current = sel.getRangeAt(0).cloneRange()
      }
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])

  useEffect(() => {
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false
      return
    }
    if (editorRef.current) {
      // Only update if the content has actually changed to avoid cursor position issues
      const currentHtml = editorRef.current.innerHTML
      const currentText = editorRef.current.textContent || ''
      
      if (htmlValue !== undefined) {
        const newHtml = htmlValue || value || ''
        if (currentHtml !== newHtml) {
          editorRef.current.innerHTML = newHtml
        }
      } else if (!htmlValue && value !== undefined) {
        if (currentText !== value) {
          editorRef.current.textContent = value
        }
      } else if (!value && !htmlValue) {
        // Clear the editor when both are empty
        editorRef.current.innerHTML = ''
      }
    }
  }, [value, htmlValue]) // Update when value or htmlValue changes

  const handleInput = () => {
    if (editorRef.current) {
      isInternalUpdate.current = true
      const html = sanitizeHtml(editorRef.current.innerHTML)
      const text = editorRef.current.textContent || ''
      onChange(text, html)
    }
  }

  const execCommand = (command: string, value?: string) => {
    if (!editorRef.current) return
    
    editorRef.current.focus()

    // Restore saved selection (may have been lost when toolbar button was tapped on mobile)
    if (savedSelection.current) {
      try {
        if (editorRef.current.contains(savedSelection.current.startContainer)) {
          const sel = window.getSelection()
          if (sel) {
            sel.removeAllRanges()
            sel.addRange(savedSelection.current)
          }
        }
      } catch (e) {
        // Range may be invalid if DOM changed, just proceed without restoring
      }
    }
    
    // Force semantic tags (<b>/<i>/<u>) instead of inline styles. Without this,
    // iOS Safari un-bolds by inserting <span style="font-weight: normal"> rather
    // than unwrapping the <b>; sanitizeHtml then strips the style and collapses
    // the span, so the text stays bold and tapping B/I/U appears to do nothing.
    try { document.execCommand('styleWithCSS', false, 'false') } catch (e) {}

    // List commands: do this manually rather than via execCommand. Chrome's
    // execCommand('insertUnorderedList') on a <li> that contains a <p> and
    // trailing <br> (the state produced by the new fullscreen editor + Shift+Enter)
    // sometimes mutates adjacent lists — turning a sibling <ul> into <ol>. Manual
    // DOM manipulation avoids that.
    if (command === 'insertUnorderedList' || command === 'insertOrderedList') {
      const targetTag = command === 'insertUnorderedList' ? 'UL' : 'OL'
      const selection = window.getSelection()
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      const startContainer = range?.startContainer
      const currentLi = startContainer
        ? (startContainer.nodeType === Node.ELEMENT_NODE
            ? (startContainer as Element).closest('li')
            : startContainer.parentElement?.closest('li')) as HTMLLIElement | null
        : null
      const parentList = currentLi?.parentElement as HTMLElement | null
      const parentIsList = parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')

      if (currentLi && parentList && parentIsList && selection && range) {
        if (parentList.tagName === targetTag) {
          // Already in a list of the requested type — create a nested sub-bullet
          // at the cursor. Reuse an existing nested list of the same type if one
          // exists at the end of this <li>, otherwise create one.
          let nestedList = Array.from(currentLi.children).find(
            (c) => c.tagName === targetTag
          ) as HTMLElement | undefined
          if (!nestedList) {
            nestedList = document.createElement(targetTag.toLowerCase())
            currentLi.appendChild(nestedList)
          }
          const newLi = document.createElement('li')
          nestedList.appendChild(newLi)
          const newRange = document.createRange()
          newRange.setStart(newLi, 0)
          newRange.collapse(true)
          selection.removeAllRanges()
          selection.addRange(newRange)
        } else {
          // Different list type — convert the parent list in place. This only
          // touches the immediate parent; sibling lists are untouched, so you
          // can't accidentally flip a neighboring <ul> into <ol>.
          const newList = document.createElement(targetTag.toLowerCase())
          while (parentList.firstChild) {
            newList.appendChild(parentList.firstChild)
          }
          parentList.replaceWith(newList)
        }
      } else {
        // Not in a list — let the browser create one at the cursor.
        document.execCommand(command, false)
      }
    } else {
      document.execCommand(command, false, value)
    }
    
    handleInput()
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const html = e.clipboardData.getData('text/html')
    if (html) {
      // Paste with formatting preserved but browser noise stripped
      document.execCommand('insertHTML', false, sanitizeHtml(html))
    } else {
      const text = e.clipboardData.getData('text/plain')
      document.execCommand('insertText', false, text)
    }
    handleInput()
  }

  const indentList = () => {
    if (!editorRef.current) return
    
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    
    const range = selection.getRangeAt(0)
    const container = range.commonAncestorContainer
    const listItem = container.nodeType === Node.ELEMENT_NODE
      ? (container as Element).closest('li')
      : container.parentElement?.closest('li')
    
    if (listItem) {
      const list = listItem.parentElement
      if (list && (list.tagName === 'UL' || list.tagName === 'OL')) {
        // Check if previous sibling is a list item
        const prevSibling = listItem.previousElementSibling
        if (prevSibling && prevSibling.tagName === 'LI') {
          // Save cursor position relative to the list item content
          const offset = range.startOffset
          const startContainer = range.startContainer
          
          // Move current item into previous item as nested list
          let nestedList = prevSibling.querySelector('ul, ol')
          if (!nestedList) {
            // Create a nested list of the same type as the parent
            nestedList = document.createElement(list.tagName.toLowerCase() as 'ul' | 'ol')
            prevSibling.appendChild(nestedList)
          }
          nestedList.appendChild(listItem)
          
          // Try to restore cursor position
          try {
            if (startContainer.nodeType === Node.TEXT_NODE && startContainer.parentElement === listItem) {
              const newRange = document.createRange()
              newRange.setStart(startContainer, Math.min(offset, startContainer.textContent?.length || 0))
              newRange.collapse(true)
              selection.removeAllRanges()
              selection.addRange(newRange)
            } else {
              // Fallback: set cursor at start of list item
              const textNode = listItem.firstChild
              if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                const newRange = document.createRange()
                newRange.setStart(textNode, 0)
                newRange.collapse(true)
                selection.removeAllRanges()
                selection.addRange(newRange)
              }
            }
          } catch (e) {
            // If cursor restoration fails, just focus the editor
            editorRef.current.focus()
          }
          
          handleInput()
        }
      }
    }
  }

  const outdentList = () => {
    if (!editorRef.current) return
    
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    
    const range = selection.getRangeAt(0)
    const container = range.commonAncestorContainer
    const listItem = container.nodeType === Node.ELEMENT_NODE
      ? (container as Element).closest('li')
      : container.parentElement?.closest('li')
    
    if (listItem) {
      const list = listItem.parentElement
      if (list && (list.tagName === 'UL' || list.tagName === 'OL')) {
        const parentList = list.parentElement
        if (parentList && parentList.tagName === 'LI') {
          // Save cursor position
          const offset = range.startOffset
          const startContainer = range.startContainer
          
          // Move item up one level - insert after the parent list item
          const grandparentList = parentList.parentElement
          if (grandparentList && (grandparentList.tagName === 'UL' || grandparentList.tagName === 'OL')) {
            // Insert the list item after the parent list item
            if (parentList.nextSibling) {
              grandparentList.insertBefore(listItem, parentList.nextSibling)
            } else {
              grandparentList.appendChild(listItem)
            }
            // Remove empty nested list if it's now empty
            if (list.children.length === 0) {
              list.remove()
            }
            
            // Try to restore cursor position
            try {
              if (startContainer.nodeType === Node.TEXT_NODE && startContainer.parentElement === listItem) {
                const newRange = document.createRange()
                newRange.setStart(startContainer, Math.min(offset, startContainer.textContent?.length || 0))
                newRange.collapse(true)
                selection.removeAllRanges()
                selection.addRange(newRange)
              } else {
                // Fallback: set cursor at start of list item
                const textNode = listItem.firstChild
                if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                  const newRange = document.createRange()
                  newRange.setStart(textNode, 0)
                  newRange.collapse(true)
                  selection.removeAllRanges()
                  selection.addRange(newRange)
                }
              }
            } catch (e) {
              // If cursor restoration fails, just focus the editor
              editorRef.current.focus()
            }
            
            handleInput()
          }
        } else if (list && (list.tagName === 'UL' || list.tagName === 'OL')) {
          // Already at top level, can't outdent further
        }
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Tab key for indenting/outdenting lists
    if (e.key === 'Tab' && editorRef.current) {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        const container = range.commonAncestorContainer
        const listItem = container.nodeType === Node.ELEMENT_NODE
          ? (container as Element).closest('li')
          : container.parentElement?.closest('li')
        
        if (listItem) {
          e.preventDefault()
          if (e.shiftKey) {
            outdentList()
          } else {
            indentList()
          }
          return
        }
      }
    }
    
    // Enter/Shift+Enter use the browser's native behavior. A previous custom
    // Shift+Enter override left the range in an inverted state, which made the
    // browser reflow <ul> into <ol> on the next keystroke (especially with the
    // new editor's <p>-inside-<li> structure).
  }

  const toolbar = (
    <div
      className={`flex items-center gap-0.5 ${fullscreen ? 'mb-3' : 'mt-3'} transition-all duration-200 ${
        isFocused || fullscreen ? 'opacity-100 translate-y-0' : 'opacity-40 translate-y-0'
      }`}
    >
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); execCommand('bold') }}
          className="w-8 h-8 flex items-center justify-center text-sm font-bold text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="Bold"
        >
          B
        </button>
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); execCommand('italic') }}
          className="w-8 h-8 flex items-center justify-center text-sm italic text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="Italic"
        >
          I
        </button>
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); execCommand('underline') }}
          className="w-8 h-8 flex items-center justify-center text-sm underline text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="Underline"
        >
          U
        </button>
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); execCommand('strikeThrough') }}
          className="w-8 h-8 flex items-center justify-center text-sm line-through text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="Strikethrough"
        >
          S
        </button>
        <div className="w-px h-5 bg-gray-200 dark:bg-gray-700 mx-1" />
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); execCommand('insertUnorderedList') }}
          className="w-8 h-8 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="Bullet List"
        >
          •
        </button>
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); execCommand('insertOrderedList') }}
          className="w-8 h-8 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="Numbered List"
        >
          1.
        </button>
        <div className="w-px h-5 bg-gray-200 dark:bg-gray-700 mx-1" />
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); indentList() }}
          className="w-8 h-8 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="Indent (Tab)"
        >
          →
        </button>
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); outdentList() }}
          className="w-8 h-8 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="Outdent (Shift+Tab)"
        >
          ←
        </button>

        {/* Hint */}
        <span className="ml-auto text-xs text-gray-300 dark:text-gray-600 select-none hidden sm:inline">
          Shift + Enter ↵ for line break · Blank line ↵↵ to split
        </span>

        {onToggleFullscreen && (
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); onToggleFullscreen() }}
            className="ml-auto sm:ml-2 w-8 h-8 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            title={fullscreen ? 'Minimize (Esc)' : 'Fullscreen'}
            aria-label={fullscreen ? 'Minimize editor' : 'Expand editor to fullscreen'}
          >
            {fullscreen ? (
              // Arrows pointing INWARD — minimize
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V5M9 9H5M9 9L4 4M15 9V5M15 9h4M15 9l5-5M9 15v4M9 15H5M9 15l-5 5M15 15v4M15 15h4M15 15l5 5" />
              </svg>
            ) : (
              // Arrows pointing OUTWARD — expand
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M4 4l5 5M20 8V4h-4M20 4l-5 5M4 16v4h4M4 20l5-5M20 16v4h-4M20 20l-5-5" />
              </svg>
            )}
          </button>
        )}
      </div>
  )

  const editor = (
    <div
      ref={editorRef}
      contentEditable
      onInput={handleInput}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      className={`${fullscreen ? 'flex-1 min-h-0 overflow-y-auto px-2 py-4 text-xl leading-relaxed' : 'min-h-[2.5rem] px-1 pt-1 pb-3 text-lg leading-relaxed'} text-gray-900 dark:text-gray-100 focus:outline-none rich-text-editor`}
      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word', ...(fullscreen ? {} : { overflow: 'hidden' }) }}
      data-placeholder={placeholder || 'Type your answer here...'}
      suppressContentEditableWarning
    />
  )

  const accent = (
    <div
      className={`h-0.5 rounded-full transition-all duration-300 ${
        isFocused
          ? 'bg-gradient-to-r from-indigo-500 to-purple-500 scale-x-100'
          : 'bg-gray-200 dark:bg-gray-700 scale-x-100'
      }`}
    />
  )

  // Keep children in a stable DOM/JSX order (toolbar, accent, editor) and flip
  // visual order via flex-direction. If the contentEditable's position in the
  // tree changed between modes, React would remount it and any unsaved typing
  // would be lost on fullscreen toggle.
  return (
    <div
      className={`relative flex ${
        fullscreen ? 'flex-col flex-1 min-h-0' : 'flex-col-reverse'
      }`}
    >
      {toolbar}
      {accent}
      {editor}
    </div>
  )
}
