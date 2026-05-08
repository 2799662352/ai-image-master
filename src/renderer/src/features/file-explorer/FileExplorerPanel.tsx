import { useRef, useEffect, useState } from 'react'
import { useFileExplorerStore } from './store'
import { FileTree } from './FileTree'
import { FileTreeIcon, CloseIcon } from './icons'

export function FileExplorerPanel({ rightOffset }: { rightOffset: number }) {
  const { fxOpen, fxTreeWidth, setFxTreeWidth, setFxOpen } = useFileExplorerStore()
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)

  useEffect(() => {
    if (!dragging) return undefined
    const onMove = (e: MouseEvent) => setFxTreeWidth(startW.current + (e.clientX - startX.current))
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, setFxTreeWidth])

  if (!fxOpen) return null

  return (
    <div
      role="region"
      aria-label="File Explorer"
      style={{ right: rightOffset }}
      className="fixed bottom-0 left-0 top-0 z-30 flex flex-col border-r border-cyan-500/20 bg-black/85 backdrop-blur-sm"
    >
      <header className="flex h-9 items-center justify-between border-b border-cyan-500/15 px-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-cyan-200/70">
          <FileTreeIcon />
          Files
        </div>
        <button
          type="button"
          onClick={() => setFxOpen(false)}
          className="rounded p-1 text-cyan-300/60 hover:bg-white/5 hover:text-cyan-200"
          aria-label="Close file explorer"
          title="Close (Ctrl/Cmd+Shift+I)"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div style={{ width: fxTreeWidth }} className="overflow-hidden border-r border-cyan-500/10">
          <FileTree />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(e) => {
            startX.current = e.clientX
            startW.current = fxTreeWidth
            setDragging(true)
          }}
          className="w-1 cursor-col-resize hover:bg-cyan-400/30"
        />

        <div className="min-w-0 flex-1 overflow-auto bg-black/40">
          <div className="flex h-full items-center justify-center text-xs text-cyan-300/30">
            Open a file to begin
          </div>
        </div>
      </div>
    </div>
  )
}
