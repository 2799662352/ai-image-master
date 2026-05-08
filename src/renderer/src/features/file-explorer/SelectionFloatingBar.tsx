import { useEffect, useState } from 'react'
import type { EditorView } from '@codemirror/view'

export function SelectionFloatingBar({ view, onSend }: { view: EditorView | null; onSend: () => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!view) return undefined
    const update = () => {
      const sel = view.state.selection.main
      if (sel.empty) {
        setPos(null)
        return
      }
      const r = view.coordsAtPos(sel.from)
      if (!r) {
        setPos(null)
        return
      }
      setPos({ top: r.top - 32, left: r.left })
    }
    update()
    view.dom.addEventListener('mouseup', update)
    view.dom.addEventListener('keyup', update)
    return () => {
      view.dom.removeEventListener('mouseup', update)
      view.dom.removeEventListener('keyup', update)
    }
  }, [view])

  if (!pos) return null
  return (
    <button
      type="button"
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 50 }}
      onClick={onSend}
      className="rounded border border-cyan-400/40 bg-cyan-500/30 px-2 py-1 text-xs text-cyan-50 hover:bg-cyan-500/50"
    >
      Send to chat Ctrl/Cmd+L
    </button>
  )
}
