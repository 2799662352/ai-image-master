import { useState } from 'react'
import type { FileTab } from './types'
import { useFileUrl } from './useFileUrl'

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

export function ImageViewer({ tab }: { tab: FileTab }) {
  const [zoom, setZoom] = useState(1)
  const file = useFileUrl(tab.path)

  return (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-auto bg-black/60 p-4">
      {file.status === 'loading' && (
        <span className="text-sm text-cyan-300/60">加载中…</span>
      )}
      {file.status === 'error' && (
        <span className="text-sm text-red-400">加载失败: {file.reason}</span>
      )}
      {file.status === 'ready' && (
        <img
          src={file.url}
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
          alt={tab.name}
          className="max-h-full max-w-full object-contain"
        />
      )}
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
        <button
          type="button"
          onClick={() => {
            const shell = window.electronAPI?.shell as ShellBridge | undefined
            void shell?.showItemInFolder?.(tab.path)
          }}
          className="ml-1 border-l border-cyan-500/20 pl-2"
        >
          显示
        </button>
      </div>
    </div>
  )
}
