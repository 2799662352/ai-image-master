import { useState } from 'react'
import type { FileTab } from './types'
import { toStreamableUri } from './uri'

/**
 * 图片查看器 —— 与视频/音频同一条流式协议。
 *
 * 此前走 IPC 读全文件 → base64 → blob:。图片没有 Range 可言,所以那条路一直"能用",
 * 但代价一直在:base64 让字节胖三分之一再跨进程,整份解码压在渲染进程内存里,
 * 还顶着 `attachments:read-thumb` 的 100MB 上限。一张 8K 截图或多层 PSD 导出的
 * PNG 就能让打开这一下明显顿一拍。
 *
 * 协议这条路在视频上验证通过后,图片没有留在旧路的理由:同样是 `createReadStream`
 * 按需读盘,浏览器自己解码,不经 base64、不进 JS 内存。
 */

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

export function ImageViewer({ tab }: { tab: FileTab }) {
  const [zoom, setZoom] = useState(1)
  const src = toStreamableUri(tab.path)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  return (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-auto bg-black/60 p-4">
      {failedSrc === src ? (
        <div className="max-w-lg space-y-2 text-center">
          <div className="text-sm text-red-400">无法显示这张图片</div>
          <div className="break-all font-mono text-[10px] text-white/35">{src}</div>
        </div>
      ) : (
        <img
          key={src}
          src={src}
          onError={() => setFailedSrc(src)}
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
