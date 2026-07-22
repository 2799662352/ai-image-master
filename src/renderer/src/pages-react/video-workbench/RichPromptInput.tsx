// 富文本提示词输入 —— 移植自 soraui JimengRichInput(contentEditable 方案)。
//
// 机制:对外 value 始终是**纯文本**(内含 `【@图片1】` 等 token);渲染时 token
// 换成不可编辑的内联 chip(缩略图+标签),编辑时再从 DOM 反解析回纯文本。
// `@` 触发建议弹层:先列本卡已有素材(插 token),再列人像库匹配素材
// (选中= onPickAsset 入素材 + 插 token)。chip 悬停显示大图预览。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { SeedanceAssetItem } from '../../../../types/seedance'
import {
  applyTokenAtCursor,
  detectAtTrigger,
  mediaToken,
  parseTokenZh,
  type MediaTokenKind,
} from '../../features/video-workbench/promptTokens'

/** 卡片素材 → 输入框可引用的媒体项。 */
export interface PromptMediaRef {
  kind: MediaTokenKind
  /** 同类内 1 起序号(token 序号)。 */
  index1: number
  name: string
  /** 可渲染的缩略图地址(img src);无则用 emoji 占位。 */
  thumbSrc?: string
}

interface SuggestionItem {
  key: string
  label: string
  detail: string
  thumbSrc?: string
  emoji: string
  /** existing = 已有素材插 token;asset = 人像库素材(先入素材再插 token)。 */
  source: 'existing' | 'asset'
  asset?: SeedanceAssetItem
}

interface RichPromptInputProps {
  value: string
  disabled?: boolean
  placeholder?: string
  mediaRefs: PromptMediaRef[]
  onChange: (value: string) => void
  /**
   * 人像库建议被选中:父组件把素材加入卡片并返回其 token 序号
   * (1 起;返回 null 表示入库失败/超限,不插 token)。
   */
  onPickAsset?: (asset: SeedanceAssetItem) => { kind: MediaTokenKind; index1: number } | null
  /** 搜索人像库(建议弹层数据源);未提供则只建议已有素材。 */
  searchAssets?: (q: string) => Promise<SeedanceAssetItem[]>
}

const KIND_EMOJI: Record<MediaTokenKind, string> = { image: '🖼', video: '🎬', audio: '🎵' }
const TOKEN_RE_G = /【@(图片|视频|音频)(\d+)】/g

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 纯文本(含 token)→ 编辑器 HTML(token 渲染为 chip)。 */
export function textToHtml(text: string, refs: PromptMediaRef[]): string {
  if (!text) return ''
  let html = escapeHtml(text).replace(/\n/g, '<br>')
  html = html.replace(TOKEN_RE_G, (match, zh: string, idx: string) => {
    const kind = parseTokenZh(zh)
    const ref = refs.find((r) => r.kind === kind && r.index1 === parseInt(idx, 10))
    const thumb = ref?.thumbSrc
      ? `<img src="${escapeHtml(ref.thumbSrc)}" class="vw-token-thumb" draggable="false" />`
      : `<span class="vw-token-emoji">${KIND_EMOJI[kind]}</span>`
    return (
      `<span class="vw-token-node" contenteditable="false" data-token="${escapeHtml(match)}"` +
      ` data-kind="${kind}" data-index="${idx}">${thumb}<span class="vw-token-label">${zh}${idx}</span></span>`
    )
  })
  return html
}

/** 编辑器 DOM → 纯文本(chip 还原为 token,br 还原为换行)。 */
export function extractPlainText(el: HTMLElement): string {
  let result = ''
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      result += n.textContent ?? ''
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const elem = n as HTMLElement
    if (elem.classList?.contains('vw-token-node')) {
      result += elem.getAttribute('data-token') ?? ''
      return
    }
    if (elem.tagName === 'BR') {
      result += '\n'
      return
    }
    elem.childNodes.forEach(walk)
  }
  el.childNodes.forEach(walk)
  return result
}

/** 计算当前 selection 在纯文本坐标系中的光标偏移。 */
function getCursorOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return extractPlainText(el).length
  const range = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  const tmp = document.createElement('div')
  tmp.appendChild(pre.cloneContents())
  return extractPlainText(tmp).length
}

/** 按纯文本偏移把光标落回编辑器(token 视为整体)。 */
function setCursorByOffset(el: HTMLElement, target: number): void {
  let remaining = target
  const place = (node: Node, offset: number): void => {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length
      if (remaining <= len) {
        place(node, remaining)
        return true
      }
      remaining -= len
      return false
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const elem = node as HTMLElement
    if (elem.classList?.contains('vw-token-node')) {
      const tokenLen = (elem.getAttribute('data-token') ?? '').length
      if (remaining <= tokenLen) {
        const range = document.createRange()
        range.setStartAfter(elem)
        range.collapse(true)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        return true
      }
      remaining -= tokenLen
      return false
    }
    if (elem.tagName === 'BR') {
      if (remaining <= 1) {
        const range = document.createRange()
        range.setStartAfter(elem)
        range.collapse(true)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        return true
      }
      remaining -= 1
      return false
    }
    for (const child of Array.from(node.childNodes)) {
      if (walk(child)) return true
    }
    return false
  }
  if (!walk(el)) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
}

/** caret 的视口坐标(空 rect 时插入零宽字符测量)。 */
function getCaretRect(): { top: number; left: number } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0).cloneRange()
  range.collapse(true)
  // jsdom 的 Range 没有 getBoundingClientRect,防御后走零宽字符兜底
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
  if (rect && (rect.top !== 0 || rect.left !== 0)) return { top: rect.top, left: rect.left }
  const span = document.createElement('span')
  span.textContent = '\u200b'
  range.insertNode(span)
  const spanRect = span.getBoundingClientRect()
  const result = { top: spanRect.top, left: spanRect.left }
  span.parentNode?.removeChild(span)
  return result
}

export function RichPromptInput({
  value,
  disabled,
  placeholder,
  mediaRefs,
  onChange,
  onPickAsset,
  searchAssets,
}: RichPromptInputProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const skipSync = useRef(false)
  const lastValue = useRef(value)
  const lastRefs = useRef(mediaRefs)

  // ---- @ 建议弹层 ----
  const [popupOpen, setPopupOpen] = useState(false)
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 })
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [assetHits, setAssetHits] = useState<SeedanceAssetItem[]>([])
  const [prefix, setPrefix] = useState('')
  const cursorRef = useRef(0)
  const textRef = useRef(value)
  const searchSeq = useRef(0)

  // ---- chip 悬停预览 ----
  const [hoverRef, setHoverRef] = useState<PromptMediaRef | null>(null)
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }, [])

  // value / mediaRefs 外部变更 → 重渲染 HTML(自己触发的 onChange 跳过)
  useEffect(() => {
    if (skipSync.current) {
      skipSync.current = false
      return
    }
    const el = editorRef.current
    if (!el) return
    const refsChanged = mediaRefs !== lastRefs.current
    if (value === lastValue.current && !refsChanged && el.innerHTML) return
    el.innerHTML = textToHtml(value, mediaRefs)
    lastValue.current = value
    lastRefs.current = mediaRefs
  }, [value, mediaRefs])

  const closePopup = useCallback(() => {
    setPopupOpen(false)
    setAssetHits([])
    setSelectedIdx(0)
  }, [])

  /** 输入后驱动 @ 检测。 */
  const runDetection = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const text = extractPlainText(el)
    const cursor = getCursorOffset(el)
    textRef.current = text
    cursorRef.current = cursor
    const det = detectAtTrigger(text, cursor)
    if (!det?.shouldShow) {
      closePopup()
      return
    }
    setPrefix(det.prefix.slice(1).toLowerCase())
    const caret = getCaretRect()
    if (caret) setPopupPos({ top: caret.top + 24, left: caret.left })
    setPopupOpen(true)
    setSelectedIdx(0)
    // 人像库远程建议(带序号防乱序回填)
    if (searchAssets) {
      const seq = ++searchSeq.current
      void searchAssets(det.prefix.slice(1)).then((items) => {
        if (seq === searchSeq.current) setAssetHits(items)
      }).catch(() => {})
    }
  }, [closePopup, searchAssets])

  const handleInput = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const text = extractPlainText(el)
    lastValue.current = text
    skipSync.current = true
    onChange(text)
    runDetection()
  }, [onChange, runDetection])

  /** 建议列表(已有素材优先,再人像库;按前缀过滤)。 */
  const suggestions = useMemo<SuggestionItem[]>(() => {
    if (!popupOpen) return []
    const list: SuggestionItem[] = []
    for (const ref of mediaRefs) {
      const zh = ref.kind === 'image' ? '图片' : ref.kind === 'video' ? '视频' : '音频'
      const label = `${zh}${ref.index1}`
      if (!prefix || label.includes(prefix) || ref.name.toLowerCase().includes(prefix) || ref.kind.includes(prefix)) {
        list.push({
          key: mediaToken(ref.kind, ref.index1),
          label,
          detail: ref.name,
          thumbSrc: ref.thumbSrc,
          emoji: KIND_EMOJI[ref.kind],
          source: 'existing',
        })
      }
    }
    const existingCount = list.length
    for (const asset of assetHits.slice(0, Math.max(2, 8 - existingCount))) {
      list.push({
        key: `asset:${asset.assetId}`,
        label: asset.name,
        detail: '人像库 · 选中后加入素材并引用',
        thumbSrc: asset.previewUrl,
        emoji: asset.kind === 'video' ? '🎬' : asset.kind === 'audio' ? '🎵' : '🖼',
        source: 'asset',
        asset,
      })
    }
    return list.slice(0, 10)
  }, [popupOpen, mediaRefs, prefix, assetHits])

  /** 应用新文本 + 光标(token 插入路径)。 */
  const applyText = useCallback(
    (nextText: string, nextCursor: number) => {
      const el = editorRef.current
      if (!el) return
      el.innerHTML = textToHtml(nextText, lastRefs.current)
      lastValue.current = nextText
      skipSync.current = true
      onChange(nextText)
      setTimeout(() => {
        const node = editorRef.current
        if (!node) return
        node.focus()
        setCursorByOffset(node, nextCursor)
      }, 0)
    },
    [onChange],
  )

  const commitSuggestion = useCallback(
    (item: SuggestionItem) => {
      let token = item.key
      if (item.source === 'asset' && item.asset) {
        const placed = onPickAsset?.(item.asset)
        if (!placed) {
          closePopup()
          return
        }
        token = mediaToken(placed.kind, placed.index1)
      }
      const { text, cursor } = applyTokenAtCursor(textRef.current, cursorRef.current, token)
      applyText(text, cursor)
      closePopup()
    },
    [onPickAsset, applyText, closePopup],
  )

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!popupOpen || suggestions.length === 0) return
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIdx((p) => (p > 0 ? p - 1 : suggestions.length - 1))
          break
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIdx((p) => (p < suggestions.length - 1 ? p + 1 : 0))
          break
        case 'Enter': {
          e.preventDefault()
          const item = suggestions[selectedIdx]
          if (item) commitSuggestion(item)
          break
        }
        case 'Escape':
          e.preventDefault()
          closePopup()
          break
        default:
          break
      }
    },
    [popupOpen, suggestions, selectedIdx, commitSuggestion, closePopup],
  )

  // ---- chip 悬停预览 ----
  const handleMouseOver = useCallback(
    (e: ReactMouseEvent) => {
      const target = e.target as HTMLElement
      const node = target.closest?.('.vw-token-node') as HTMLElement | null
      if (!node) return
      const kind = node.getAttribute('data-kind') as MediaTokenKind | null
      const idx = node.getAttribute('data-index')
      if (!kind || !idx) return
      const ref = mediaRefs.find((r) => r.kind === kind && r.index1 === parseInt(idx, 10))
      if (!ref?.thumbSrc) return
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      setHoverRef(ref)
      setHoverRect(node.getBoundingClientRect())
    },
    [mediaRefs],
  )

  const handleMouseOut = useCallback((e: ReactMouseEvent) => {
    const related = e.relatedTarget as HTMLElement | null
    if (related?.closest?.('.vw-token-node') || related?.closest?.('.vw-chip-preview')) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => {
      setHoverRef(null)
      setHoverRect(null)
    }, 120)
  }, [])

  return (
    <div className="relative w-full">
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="视频提示词"
        data-placeholder={placeholder}
        className={`vw-rich-input ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
        onInput={handleInput}
        onCompositionEnd={handleInput}
        onKeyDown={handleKeyDown}
        onKeyUp={runDetection}
        onMouseUp={runDetection}
        onBlur={() => setTimeout(closePopup, 150)}
        onMouseOver={handleMouseOver}
        onMouseOut={handleMouseOut}
      />

      {popupOpen && suggestions.length > 0 &&
        createPortal(
          <div
            className="vw-at-popup"
            style={{ top: popupPos.top, left: popupPos.left }}
            data-testid="vw-at-popup"
            onMouseDown={(e) => e.preventDefault() /* 防编辑器失焦 */}
          >
            {suggestions.map((s, i) => (
              <button
                key={s.key}
                type="button"
                className={`vw-at-item ${i === selectedIdx ? 'vw-at-active' : ''}`}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => commitSuggestion(s)}
              >
                {s.thumbSrc ? (
                  <img src={s.thumbSrc} alt="" className="vw-at-thumb" draggable={false} />
                ) : (
                  <span className="vw-at-emoji">{s.emoji}</span>
                )}
                <span className="vw-at-label">{s.label}</span>
                <span className="vw-at-detail">{s.detail}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}

      {hoverRef && hoverRect &&
        createPortal(
          <div
            className="vw-chip-preview"
            style={{
              top: Math.max(8, hoverRect.top - 8),
              left: Math.min(hoverRect.left, window.innerWidth - 240),
              transform: 'translateY(-100%)',
            }}
            onMouseEnter={() => {
              if (hoverTimer.current) clearTimeout(hoverTimer.current)
            }}
            onMouseLeave={() => {
              setHoverRef(null)
              setHoverRect(null)
            }}
          >
            <img src={hoverRef.thumbSrc} alt={hoverRef.name} draggable={false} />
            <div className="vw-chip-preview-label">
              {KIND_EMOJI[hoverRef.kind]} {hoverRef.name}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
