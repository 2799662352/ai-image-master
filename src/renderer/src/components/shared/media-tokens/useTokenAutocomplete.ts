import { useState, useCallback, useRef, useEffect } from 'react'
import type { MediaRef } from './types'
import { makeToken } from './types'

interface Props {
  mediaRefs: MediaRef[]
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onValueChange: (v: string) => void
}

interface Return {
  visible: boolean
  suggestions: MediaRef[]
  selectedIndex: number
  position: { top: number; left: number }
  handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown: (e: React.KeyboardEvent) => void
  handleClose: () => void
  handleHover: (index: number) => void
}

const AT_VALID_BEFORE = /[\s\n\r】）})\]」』]/
const AT_INVALID_BEFORE = /[^\s\n\r,，。！？!?;；】）})\]」』]/

function getCaretCoordinates(
  el: HTMLTextAreaElement,
  pos: number,
  textOverride?: string,
): { top: number; left: number } {
  const div = document.createElement('div')
  const style = getComputedStyle(el)
  const props = [
    'font', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle',
    'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent',
    'whiteSpace', 'lineHeight', 'padding', 'border', 'boxSizing',
  ] as const
  for (const p of props) (div.style as any)[p] = (style as any)[p]
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.overflow = 'hidden'
  div.style.width = el.clientWidth + 'px'
  div.style.height = el.clientHeight + 'px'

  const text = textOverride ?? el.value
  div.textContent = text.substring(0, pos)
  const span = document.createElement('span')
  span.textContent = '|'
  div.appendChild(span)
  document.body.appendChild(div)

  const spanRect = span.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  document.body.removeChild(div)

  return {
    top: spanRect.top - elRect.top + el.scrollTop,
    left: spanRect.left - elRect.left + el.scrollLeft,
  }
}

function detectAt(text: string, cursor: number) {
  let atPos = -1
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i]
    if (/[\s\n\r,，。！？!?;；]/.test(ch)) break
    if (ch === '@') { atPos = i; break }
  }
  if (atPos === -1) return null
  const isValid = atPos === 0 || AT_VALID_BEFORE.test(text[atPos - 1])
  return isValid ? { atPos, prefix: text.substring(atPos, cursor) } : null
}

export function useTokenAutocomplete({
  mediaRefs,
  textareaRef,
  value,
  onValueChange,
}: Props): Return {
  const [visible, setVisible] = useState(false)
  const [suggestions, setSuggestions] = useState<MediaRef[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  const pendingCursorRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const atPosRef = useRef(-1)

  // stable refs for latest values inside callbacks
  const mediaRefsRef = useRef(mediaRefs)
  mediaRefsRef.current = mediaRefs
  const onValueChangeRef = useRef(onValueChange)
  onValueChangeRef.current = onValueChange
  const suggestionsRef = useRef(suggestions)
  suggestionsRef.current = suggestions
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // cursor restoration after token insertion / auto-spacing
  useEffect(() => {
    if (pendingCursorRef.current !== null && textareaRef.current) {
      const c = pendingCursorRef.current
      textareaRef.current.selectionStart = c
      textareaRef.current.selectionEnd = c
      pendingCursorRef.current = null
    }
  })

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const filterSuggestions = useCallback((cleanPrefix: string) => {
    const refs = mediaRefsRef.current
    if (refs.length === 0) {
      setSuggestions([])
      setSelectedIndex(0)
      return
    }
    const filtered = refs.filter((r) => {
      if (cleanPrefix === '') return true
      const label = (r.label || `图片${r.index}`).toLowerCase()
      const matchesLabel = label.includes(cleanPrefix)
      const matchesType = '图片'.includes(cleanPrefix)
      const matchesIndex = !isNaN(Number(cleanPrefix)) && r.index === Number(cleanPrefix)
      return matchesLabel || matchesType || matchesIndex
    })
    setSuggestions(filtered)
    setSelectedIndex(0)
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    let text = e.target.value
    let cursor = e.target.selectionStart ?? text.length

    // auto-spacing: if @ preceded by non-whitespace/non-punctuation, insert space
    if (cursor >= 2 && text[cursor - 1] === '@') {
      const prev = text[cursor - 2]
      if (prev && AT_INVALID_BEFORE.test(prev)) {
        text = text.substring(0, cursor - 1) + ' @' + text.substring(cursor)
        cursor += 1
        pendingCursorRef.current = cursor
      }
    }

    onValueChangeRef.current(text)

    const el = textareaRef.current
    if (!el) return

    const det = detectAt(text, cursor)
    if (!det) {
      setVisible(false)
      atPosRef.current = -1
      return
    }

    atPosRef.current = det.atPos
    const cleanPrefix = det.prefix.slice(1).toLowerCase()

    const caret = getCaretCoordinates(el, det.atPos, text)
    const elRect = el.getBoundingClientRect()
    setPosition({
      top: elRect.top + caret.top + 25,
      left: elRect.left + caret.left,
    })

    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => filterSuggestions(cleanPrefix), 80)
    setVisible(true)
  }, [textareaRef, filterSuggestions])

  const selectToken = useCallback((ref: MediaRef) => {
    const el = textareaRef.current
    if (!el) return
    const text = el.value
    const cursor = el.selectionStart ?? text.length
    const aPos = atPosRef.current
    if (aPos < 0) return

    const token = makeToken(ref.index)
    const before = text.substring(0, aPos)
    const after = text.substring(cursor)
    const needSpaceBefore = before.length > 0 && !/[\s\n]$/.test(before)
    const needSpaceAfter = after.length > 0 && !/^[\s\n]/.test(after)
    const sb = needSpaceBefore ? ' ' : ''
    const sa = needSpaceAfter ? ' ' : ''
    const newText = before + sb + token + sa + after
    const newCursor = before.length + sb.length + token.length + sa.length

    onValueChangeRef.current(newText)
    pendingCursorRef.current = newCursor

    setVisible(false)
    setSuggestions([])
    setSelectedIndex(0)
    atPosRef.current = -1
  }, [textareaRef])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!visibleRef.current || suggestionsRef.current.length === 0) {
      if (visibleRef.current && e.key === 'Escape') {
        e.preventDefault()
        setVisible(false)
        atPosRef.current = -1
      }
      return
    }

    const len = suggestionsRef.current.length
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex((p) => (p > 0 ? p - 1 : len - 1))
        break
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex((p) => (p < len - 1 ? p + 1 : 0))
        break
      case 'Enter':
        e.preventDefault()
        selectToken(suggestionsRef.current[selectedIndexRef.current])
        break
      case 'Escape':
        e.preventDefault()
        setVisible(false)
        setSuggestions([])
        setSelectedIndex(0)
        atPosRef.current = -1
        break
      case ' ':
        setVisible(false)
        setSuggestions([])
        setSelectedIndex(0)
        atPosRef.current = -1
        break
    }
  }, [selectToken])

  const handleClose = useCallback(() => {
    setVisible(false)
    setSuggestions([])
    setSelectedIndex(0)
    atPosRef.current = -1
  }, [])

  const handleHover = useCallback((index: number) => {
    setSelectedIndex(index)
  }, [])

  return {
    visible,
    suggestions,
    selectedIndex,
    position,
    handleChange,
    handleKeyDown,
    handleClose,
    handleHover,
  }
}
