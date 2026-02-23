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
  const isInternalUpdate = useRef(false)
  const [isFocused, setIsFocused] = useState(false)

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
    const html = e.clipboardData.getData('text/html')
    if (html) {
      // Paste with formatting preserved (bold, italic, underline, strikethrough, etc.)
      document.execCommand('insertHTML', false, html)
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

  const toolbarBtnClass = "px-3 py-1.5 text-sm rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 bg-white/80 dark:bg-gray-600/80 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-600 dark:hover:text-indigo-300 text-gray-700 dark:text-gray-300"

  return (
    <div className="rich-text-elegant">
      <div className="flex gap-1 p-2.5 bg-gray-50/80 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-600/50 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => execCommand('bold')}
          className={`${toolbarBtnClass} font-bold`}
          title="Bold"
        >
          B
        </button>
        <button
          type="button"
          onClick={() => execCommand('italic')}
          className={`${toolbarBtnClass} italic`}
          title="Italic"
        >
          I
        </button>
        <button
          type="button"
          onClick={() => execCommand('underline')}
          className={`${toolbarBtnClass} underline`}
          title="Underline"
        >
          U
        </button>
        <button
          type="button"
          onClick={() => execCommand('strikeThrough')}
          className={`${toolbarBtnClass} line-through`}
          title="Strikethrough"
        >
          S
        </button>
        <div className="w-px bg-gray-200 dark:bg-gray-600/50 mx-1.5 self-stretch" />
        <button
          type="button"
          onClick={() => execCommand('insertUnorderedList')}
          className={toolbarBtnClass}
          title="Bullet List"
        >
          •
        </button>
        <button
          type="button"
          onClick={() => execCommand('insertOrderedList')}
          className={toolbarBtnClass}
          title="Numbered List"
        >
          1.
        </button>
        <div className="w-px bg-gray-200 dark:bg-gray-600/50 mx-1.5 self-stretch" />
        <button
          type="button"
          onClick={indentList}
          className={toolbarBtnClass}
          title="Indent (Tab)"
        >
          →
        </button>
        <button
          type="button"
          onClick={outdentList}
          className={toolbarBtnClass}
          title="Outdent (Shift+Tab)"
        >
          ←
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
        className="min-h-[160px] px-5 py-3 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200 focus:outline-none rich-text-editor text-base leading-relaxed"
        style={{ whiteSpace: 'pre-wrap' }}
        data-placeholder={placeholder}
        suppressContentEditableWarning
      />
    </div>
  )
}

