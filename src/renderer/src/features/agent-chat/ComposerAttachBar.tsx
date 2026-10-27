import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

interface ComposerAttachBarProps {
  attachmentCount: number
  attachmentMax: number
  disabled?: boolean
  onPickFiles: () => void
  onSketch: () => void
  onGenerateImage: () => void
}

interface Action {
  id: 'files' | 'sketch' | 'generate'
  title: string
  subtitle: string
  icon: JSX.Element
  run: () => void
}

function stroke(d: string, size = 14): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICON_FILES = 'M16 5h6M19 2v6M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5M21 15l-5-5L5 21'
const ICON_SKETCH = 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'
const ICON_GENERATE = 'm12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3ZM5 3v4M19 17v4M3 5h4M17 19h4'

/**
 * The composer attach bar (design D2, revised after user feedback): a
 * full-width dashed row between the textarea and the pill row — the same
 * silhouette as the old "Add references or files" strip — that carries the
 * three actions inline (添加照片和文件 / 绘图 / 生成图片) plus the attachment
 * quota at the right. The leading「+」keeps the menu (same three items with
 * their hints) so nothing the「+」did is lost. Drag-drop and Ctrl+V are
 * untouched; this is only the discoverable entry.
 */
export function ComposerAttachBar(props: ComposerAttachBarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const full = props.attachmentCount >= props.attachmentMax

  useEffect(() => {
    if (!menuOpen) return undefined
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const actions: Action[] = [
    { id: 'files', title: '添加照片和文件', subtitle: '从电脑上传 · 也可拖放 / Ctrl+V', icon: stroke(ICON_FILES), run: props.onPickFiles },
    { id: 'sketch', title: '绘图', subtitle: '绘制并附加草图(tldraw)', icon: stroke(ICON_SKETCH), run: props.onSketch },
    { id: 'generate', title: '生成图片', subtitle: '调用出图工具,走当前通道', icon: stroke(ICON_GENERATE), run: props.onGenerateImage },
  ]
  const actionDisabled = (a: Action): boolean => !!props.disabled || (a.id === 'files' && full)

  return (
    <div ref={rootRef} className="relative mt-2">
      <div
        role="toolbar"
        aria-label="添加内容"
        className={[
          'flex h-9 items-center gap-1 rounded-lg border border-dashed pl-1 pr-2.5 transition-colors duration-200',
          menuOpen ? 'border-cyan-300/60 bg-cyan-400/[0.07]' : 'border-cyan-400/30 bg-cyan-400/[0.04] hover:border-cyan-300/50',
        ].join(' ')}
      >
        <button
          type="button"
          aria-label="更多添加方式"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={props.disabled}
          title="添加照片 / 草图 / 生成图片"
          onClick={() => setMenuOpen((v) => !v)}
          className={[
            'inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors duration-200',
            menuOpen ? 'bg-cyan-200 text-zinc-950' : 'bg-cyan-300 text-zinc-950 hover:bg-cyan-200',
            'disabled:cursor-not-allowed disabled:opacity-40',
          ].join(' ')}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" aria-hidden="true" className={`transition-transform duration-200 ${menuOpen ? 'rotate-45' : ''}`}>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {actions.map((a, i) => (
          <span key={a.id} className={`flex min-w-0 items-center ${a.id === 'files' ? 'flex-1' : ''}`}>
            {i > 0 ? <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-cyan-400/20" /> : null}
            <button
              type="button"
              aria-label={a.title}
              title={a.subtitle}
              disabled={actionDisabled(a)}
              onClick={a.run}
              className={[
                'inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[11px] text-cyan-100/90 transition-colors duration-200',
                'hover:bg-cyan-400/10 hover:text-cyan-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                a.id === 'files' ? 'w-full justify-start' : '',
              ].join(' ')}
            >
              <span className="shrink-0 text-cyan-300/80">{a.icon}</span>
              <span className="truncate">{a.title}</span>
            </button>
          </span>
        ))}
        <span className={`ml-1 shrink-0 font-mono text-[10px] tabular-nums ${full ? 'text-amber-300/90' : 'text-zinc-500'}`}>
          {props.attachmentCount}/{props.attachmentMax}
        </span>
      </div>
      {menuOpen ? (
        <div
          role="menu"
          aria-label="添加内容"
          className="absolute bottom-[calc(100%+6px)] left-0 z-20 w-[300px] overflow-hidden rounded-lg border border-cyan-400/25 bg-zinc-950/95 py-1.5 shadow-2xl shadow-black/60 backdrop-blur-md"
        >
          {actions.map((a) => (
            <button
              key={a.id}
              role="menuitem"
              type="button"
              disabled={actionDisabled(a)}
              onClick={() => {
                setMenuOpen(false)
                a.run()
              }}
              className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-cyan-400/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-700/70 bg-zinc-900/70 text-cyan-200">
                {stroke(a.id === 'files' ? ICON_FILES : a.id === 'sketch' ? ICON_SKETCH : ICON_GENERATE, 15)}
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-zinc-100">{a.title}</span>
                <span className="block truncate text-[10px] text-zinc-500">{a.subtitle}</span>
              </span>
            </button>
          ))}
          <div className="mx-3 mt-1 flex items-center justify-between border-t border-cyan-400/15 pt-1.5 text-[10px] text-zinc-500">
            <span>Esc 关闭</span>
            <span className="font-mono tabular-nums">
              {props.attachmentCount}/{props.attachmentMax}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
