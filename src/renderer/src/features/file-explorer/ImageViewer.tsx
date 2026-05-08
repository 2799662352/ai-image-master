import { useState } from 'react'
import type { FileTab } from './types'
import { toRenderableUri } from './uri'

export function ImageViewer({ tab }: { tab: FileTab }) {
  const [zoom, setZoom] = useState(1)
  const src = toRenderableUri(tab.path)
  return (
    <div className="relative flex h-full items-center justify-center overflow-auto bg-black/40">
      <img src={src} style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }} alt={tab.name} />
      <div className="absolute bottom-3 right-3 flex gap-1 rounded bg-black/70 px-2 py-1 text-xs text-cyan-200">
        <button type="button" onClick={() => setZoom((z) => z / 1.25)} className="px-1">
          -
        </button>
        <button type="button" onClick={() => setZoom(1)} className="px-1">
          1:1
        </button>
        <button type="button" onClick={() => setZoom((z) => z * 1.25)} className="px-1">
          +
        </button>
      </div>
    </div>
  )
}
