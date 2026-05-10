import { useEffect, useRef } from 'react'

export type FileMenuAction =
  | 'open'
  | 'newFile'
  | 'newFolder'
  | 'reveal'
  | 'openTerminal'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'copyPath'
  | 'copyRelativePath'
  | 'rename'
  | 'trash'
  | 'compareSelected'

export interface MenuItemDescriptor {
  id: FileMenuAction
  label: string
  shortcut?: string
  danger?: boolean
  separatorAfter?: boolean
  disabled?: boolean
}

export interface FileContextMenuProps {
  x: number
  y: number
  items: MenuItemDescriptor[]
  onSelect: (action: FileMenuAction) => void
  onClose: () => void
}

export function FileContextMenu({ x, y, items, onSelect, onClose }: FileContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : x) - 240)
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : y) - items.length * 28 - 16)

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="File actions"
      style={{ position: 'fixed', left, top, zIndex: 50000 }}
      className="min-w-[230px] rounded-md border border-cyan-500/30 bg-zinc-950/95 py-1 text-[12px] text-cyan-100 shadow-xl backdrop-blur"
    >
      {items.map((it) => (
        <div key={it.id}>
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return
              onSelect(it.id)
              onClose()
            }}
            className={
              'flex w-full cursor-pointer items-center justify-between gap-6 px-3 py-1 text-left transition-colors ' +
              (it.disabled
                ? 'cursor-not-allowed text-zinc-600'
                : it.danger
                  ? 'text-red-300 hover:bg-red-500/15 hover:text-red-200'
                  : 'hover:bg-cyan-400/10')
            }
          >
            <span>{it.label}</span>
            {it.shortcut && (
              <span className="text-[10px] tracking-wider text-zinc-500">{it.shortcut}</span>
            )}
          </button>
          {it.separatorAfter && <div className="my-1 h-px bg-cyan-500/15" />}
        </div>
      ))}
    </div>
  )
}
