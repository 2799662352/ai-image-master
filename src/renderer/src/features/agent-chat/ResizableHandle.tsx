import { useCallback, useRef } from 'react'

const MIN_WIDTH = 360
const MAX_WIDTH = 720

interface ResizableHandleProps {
  panelRight: number
  onResize: (width: number) => void
  onResizeEnd: () => void
}

export function ResizableHandle({ panelRight, onResize, onResizeEnd }: ResizableHandleProps) {
  const dragging = useRef(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragging.current = true
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'ew-resize'

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return
        const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, panelRight - ev.clientX))
        onResize(width)
      }

      const onUp = () => {
        dragging.current = false
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        onResizeEnd()
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [panelRight, onResize, onResizeEnd],
  )

  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute left-0 top-0 z-10 h-full w-1 cursor-ew-resize hover:bg-cyan-400/40 active:bg-cyan-400/60"
    />
  )
}

export { MIN_WIDTH, MAX_WIDTH }
