import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { DefaultColorStyle, DefaultSizeStyle, type Editor, Tldraw, type TLDefaultColorStyle } from 'tldraw'
import 'tldraw/tldraw.css'
import { resolveTldrawLicenseKey } from '../../agent-workspace/canvas/tldrawLicense'
import {
  SHAPE_TOOLS,
  SKETCH_COLORS,
  SKETCH_SHAPES,
  SKETCH_TOOLS,
  applySketchShape,
  exportSketch,
  type SketchShapeChoice,
  type SketchStrokeSize,
  type SketchTool,
} from './sketchExport'
import { StrokeSlider } from './StrokeSlider'

const TLDRAW_LICENSE_KEY = resolveTldrawLicenseKey()

interface SketchPadProps {
  onConfirm: (png: Blob) => void
  onCancel: () => void
}

/** Tiny outline glyphs for the 形状 flyout — one per {@link SKETCH_SHAPES} id. */
function ShapeGlyph({ id }: { id: string }): JSX.Element {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const }
  switch (id) {
    case 'rectangle':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1.5" {...common} /></svg>
    case 'ellipse':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><ellipse cx="12" cy="12" rx="8.5" ry="6" {...common} /></svg>
    case 'triangle':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 5 20 19H4Z" {...common} /></svg>
    case 'diamond':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4 20 12 12 20 4 12Z" {...common} /></svg>
    case 'star':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m12 4 2.4 5 5.4.7-3.9 3.7.9 5.4L12 16.2 7.2 18.8l.9-5.4-3.9-3.7L9.6 9Z" {...common} /></svg>
    case 'cloud':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 9a4.5 4.5 0 0 1 .5 9Z" {...common} /></svg>
    case 'heart':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 20s-7-4.4-7-9.5A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.5C19 15.6 12 20 12 20Z" {...common} /></svg>
    case 'arrow':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 19 19 5M11 5h8v8" {...common} /></svg>
    case 'line':
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 19 19 5" {...common} /></svg>
    default:
      return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="5" y="5" width="14" height="14" {...common} /></svg>
  }
}

/**
 * Sketch pad (design D3): a 560×560 modal inside the drawer built on the same
 * tldraw stack as the canvas, but with tldraw's own UI hidden and a toolbar in
 * the drawer's cyan dialect — pill tools on top (形状 is a split button with a
 * shape flyout), stroke slider on the left, palette dots at the bottom, cyan ✓
 * to confirm. No persistence key: a sketch is a one-shot attachment, not a
 * document.
 */
export function SketchPad({ onConfirm, onCancel }: SketchPadProps): JSX.Element {
  const editorRef = useRef<Editor | null>(null)
  const [tool, setTool] = useState<SketchTool>('draw')
  const [color, setColor] = useState<TLDefaultColorStyle>('black')
  const [size, setSize] = useState<SketchStrokeSize>('m')
  const [shape, setShape] = useState<SketchShapeChoice>(SKETCH_SHAPES[0])
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false)
  const shapeMenuOpenRef = useRef(false)
  shapeMenuOpenRef.current = shapeMenuOpen
  const shapeMenuRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      editor.user.updateUserPreferences({ colorScheme: 'light' })
      editor.setStyleForNextShapes(DefaultColorStyle, color)
      editor.setStyleForNextShapes(DefaultSizeStyle, size)
      editor.setCurrentTool('draw')
      editor.focus()
      const sync = (): void => {
        setCanUndo(editor.getCanUndo())
        setCanRedo(editor.getCanRedo())
      }
      sync()
      return editor.store.listen(sync, { scope: 'document', source: 'user' })
    },
    // Only the initial values matter for mount; later changes go through the setters below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const pickTool = (next: SketchTool): void => {
    setShapeMenuOpen(false)
    if (next === 'geo') {
      // 形状 pill re-applies the remembered flyout choice (geo style or arrow / line tool).
      const editor = editorRef.current
      setTool(editor ? applySketchShape(editor, shape) : 'geo')
      return
    }
    setTool(next)
    editorRef.current?.setCurrentTool(next)
  }
  const pickShape = (choice: SketchShapeChoice): void => {
    setShape(choice)
    setShapeMenuOpen(false)
    const editor = editorRef.current
    setTool(editor ? applySketchShape(editor, choice) : 'geo')
  }
  const pickColor = (next: TLDefaultColorStyle): void => {
    setColor(next)
    const editor = editorRef.current
    if (!editor) return
    editor.setStyleForNextShapes(DefaultColorStyle, next)
    if (editor.getSelectedShapeIds().length) editor.setStyleForSelectedShapes(DefaultColorStyle, next)
  }
  const pickSize = (next: SketchStrokeSize): void => {
    setSize(next)
    const editor = editorRef.current
    if (!editor) return
    editor.setStyleForNextShapes(DefaultSizeStyle, next)
    if (editor.getSelectedShapeIds().length) editor.setStyleForSelectedShapes(DefaultSizeStyle, next)
  }

  const confirm = async (): Promise<void> => {
    const editor = editorRef.current
    if (!editor || busy) return
    setBusy(true)
    try {
      const blob = await exportSketch(editor)
      if (!blob) {
        onCancel()
        return
      }
      onConfirm(blob)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // Esc closes the shape flyout first; a second Esc closes the pad.
      if (shapeMenuOpenRef.current) {
        setShapeMenuOpen(false)
        return
      }
      onCancel()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  useEffect(() => {
    if (!shapeMenuOpen) return undefined
    const onDown = (e: MouseEvent): void => {
      if (!shapeMenuRef.current?.contains(e.target as Node)) setShapeMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [shapeMenuOpen])

  const shapeActive = SHAPE_TOOLS.has(tool)

  return (
    <div
      role="dialog"
      aria-label="草图板"
      className="fixed inset-0 z-[45000] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onCancel}
    >
      <div
        className="relative flex h-[min(560px,calc(100%-32px))] w-[min(560px,calc(100%-32px))] flex-col rounded-xl border border-cyan-400/25 bg-zinc-950/95 shadow-2xl shadow-black/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 pt-3">
          <button
            type="button"
            aria-label="关闭草图板"
            onClick={onCancel}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-900/60 text-zinc-400 hover:border-cyan-300/50 hover:text-cyan-100"
          >
            ✕
          </button>
          <div className="relative" ref={shapeMenuRef}>
            <div role="toolbar" aria-label="绘图工具" className="flex items-center gap-0.5 rounded-full border border-cyan-400/25 bg-zinc-900/80 p-1 backdrop-blur-md">
              {SKETCH_TOOLS.map((t) => {
                const active = t.id === 'geo' ? shapeActive : tool === t.id
                const pillClass = active ? 'bg-cyan-400/15 text-cyan-100' : 'text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100'
                if (t.id !== 'geo') {
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => pickTool(t.id)}
                      className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${pillClass}`}
                    >
                      {t.label}
                    </button>
                  )
                }
                // 形状 = split button: left half activates the remembered shape, right caret opens the flyout.
                return (
                  <span key={t.id} className={`inline-flex items-center rounded-full transition-colors ${pillClass}`}>
                    <button
                      type="button"
                      aria-pressed={active}
                      title={`形状:${shape.label}`}
                      onClick={() => pickTool('geo')}
                      className="inline-flex items-center gap-1 rounded-l-full py-1 pl-2.5 pr-1 text-[11px]"
                    >
                      <span className="text-current/90"><ShapeGlyph id={shape.id} /></span>
                      {t.label}
                    </button>
                    <button
                      type="button"
                      aria-label="选择形状"
                      aria-haspopup="menu"
                      aria-expanded={shapeMenuOpen}
                      onClick={() => setShapeMenuOpen((v) => !v)}
                      className="inline-flex h-6 items-center rounded-r-full pl-0.5 pr-2 text-[10px] hover:text-cyan-100"
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform ${shapeMenuOpen ? 'rotate-180' : ''}`}>
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  </span>
                )
              })}
            </div>
            {shapeMenuOpen ? (
              <div
                role="menu"
                aria-label="选择形状"
                className="absolute left-1/2 top-[calc(100%+6px)] z-10 grid w-[264px] -translate-x-1/2 grid-cols-3 gap-1 rounded-lg border border-cyan-400/25 bg-zinc-950/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-md"
              >
                {SKETCH_SHAPES.map((c) => (
                  <button
                    key={c.id}
                    role="menuitemradio"
                    aria-checked={shape.id === c.id}
                    type="button"
                    onClick={() => pickShape(c)}
                    className={[
                      'flex flex-col items-center gap-1 rounded-md px-2 py-2 text-[10px] transition-colors',
                      shape.id === c.id ? 'bg-cyan-400/15 text-cyan-100' : 'text-zinc-300 hover:bg-cyan-400/10 hover:text-cyan-50',
                    ].join(' ')}
                  >
                    <ShapeGlyph id={c.id} />
                    {c.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="撤销"
              disabled={!canUndo}
              onClick={() => editorRef.current?.undo()}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-900/60 text-zinc-400 hover:border-cyan-300/50 hover:text-cyan-100 disabled:opacity-40"
            >
              ↶
            </button>
            <button
              type="button"
              aria-label="重做"
              disabled={!canRedo}
              onClick={() => editorRef.current?.redo()}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-900/60 text-zinc-400 hover:border-cyan-300/50 hover:text-cyan-100 disabled:opacity-40"
            >
              ↷
            </button>
          </div>
        </div>

        <div className="relative mx-3 mt-3 flex-1 overflow-hidden rounded-lg border border-zinc-700/60 bg-[#FAFAFA]">
          {/* Light paper is forced in handleMount (colorScheme: 'light'); tldraw 5.4 has no inferDarkMode prop. */}
          <Tldraw licenseKey={TLDRAW_LICENSE_KEY} hideUi autoFocus onMount={handleMount} />
          {/* Stroke width: vertical slider on the left (drag / click / ↑↓), snaps to tldraw's four stops. */}
          <div className="absolute left-2 top-1/2 -translate-y-1/2">
            <StrokeSlider value={size} onChange={pickSize} />
          </div>
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-400/25 bg-zinc-950/85 px-3 py-1.5 backdrop-blur-md" aria-label="颜色">
            {SKETCH_COLORS.map((c) => (
              <button
                key={c.style}
                type="button"
                aria-label={c.label}
                aria-pressed={color === c.style}
                onClick={() => pickColor(c.style)}
                className={[
                  'h-5 w-5 rounded-full transition-transform hover:scale-110',
                  color === c.style ? 'ring-2 ring-cyan-300 ring-offset-2 ring-offset-zinc-950' : '',
                ].join(' ')}
                style={{ background: c.hex, boxShadow: c.style === 'white' ? 'inset 0 0 0 1px #3f3f46' : undefined }}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-mono text-[10px] text-zinc-500">tldraw 画布 · 确认后作为附件加入消息 · Esc 取消</span>
          <button
            type="button"
            aria-label="确认并附加草图"
            disabled={busy}
            onClick={() => void confirm()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-cyan-300 text-zinc-950 transition-colors hover:bg-cyan-200 disabled:opacity-60"
          >
            ✓
          </button>
        </div>
      </div>
    </div>
  )
}
