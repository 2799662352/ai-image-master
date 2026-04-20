import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { MediaRef, TokenTheme } from './types'

interface Props {
  visible: boolean
  suggestions: MediaRef[]
  selectedIndex: number
  position: { top: number; left: number }
  theme: TokenTheme
  onSelect: (ref: MediaRef) => void
  onClose: () => void
  onHover: (index: number) => void
}

export default function TokenAutocomplete({
  visible,
  suggestions,
  selectedIndex,
  position,
  theme,
  onSelect,
  onClose,
  onHover,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const themeClass = `mt-theme-${theme}`

  useEffect(() => {
    if (!visible) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [visible, onClose])

  // flip above if near bottom
  const adjustedTop = (() => {
    if (typeof window === 'undefined') return position.top
    const spaceBelow = window.innerHeight - position.top
    if (spaceBelow < 260) return position.top - 250
    return position.top
  })()

  if (!visible) return null

  return createPortal(
    <div className={themeClass}>
      <div
        ref={panelRef}
        className="mt-popup"
        role="listbox"
        style={{ top: adjustedTop, left: position.left }}
      >
        {suggestions.length === 0 ? (
          <div className="mt-popup-empty">请先上传参考图</div>
        ) : (
          suggestions.map((ref, i) => (
            <div
              key={ref.index}
              role="option"
              aria-selected={i === selectedIndex}
              data-focused={i === selectedIndex ? 'true' : 'false'}
              className="mt-popup-item"
              onMouseDown={(e) => { e.preventDefault(); onSelect(ref) }}
              onMouseEnter={() => onHover(i)}
            >
              {ref.url ? (
                <img src={ref.url} alt="" className="mt-popup-thumb" />
              ) : (
                <span style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>📷</span>
              )}
              <span>{ref.label || `图片${ref.index}`}</span>
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  )
}
