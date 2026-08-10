import { useState } from 'react'
import type { FileTab } from './types'
import { toRenderableUri } from './uri'

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

/**
 * 流式加载,**不要**把文件读进内存 —— 理由同 VideoViewer,一张几十 MB 的
 * PNG/PSD 导出图同样能把两个进程一起卡住。
 */
export function ImageViewer({ tab }: { tab: FileTab }) {
  const [zoom, setZoom] = useState(1)
  const [failed, setFailed] = useState(false)
  const src = toRenderableUri(tab.path)

  return (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-auto bg-black/60 p-4">
      {failed && (
        <span className="text-sm text-red-400">加载失败:无法读取 {tab.name}</span>
      )}
      <img
        key={src}
        src={src}
        onError={() => setFailed(true)}
        style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
        alt={tab.name}
        className={`max-h-full max-w-full object-contain${failed ? ' hidden' : ''}`}
      />
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
