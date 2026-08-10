import { useState } from 'react'
import type { FileTab } from './types'
import { toRenderableUri } from './uri'

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

/**
 * 流式播放,**不要**把文件读进内存。
 *
 * 早先这里走 useFileUrl(主进程整份 readFile + base64 → IPC → 渲染端逐字节还原
 * 成 Blob)。一个 50MB 的 mp4 会让主进程和渲染进程同时卡住好几秒,窗口停止绘制。
 * `local-file://` 是已注册的特权流式协议(net.fetch,带 Range),浏览器自己取、
 * 自己 seek,内存几乎为零 —— 同一个查看器的 PDF 分支一直就是这么做的。
 */
export function VideoViewer({ tab }: { tab: FileTab }) {
  const [failed, setFailed] = useState(false)
  const src = toRenderableUri(tab.path)

  return (
    <div className="flex h-full min-h-0 flex-col bg-black/70">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {failed && (
          <span className="text-sm text-red-400">加载失败:无法读取 {tab.name}</span>
        )}
        <video
          key={src}
          src={src}
          controls
          onError={() => setFailed(true)}
          className={`max-h-full max-w-full rounded border border-cyan-500/20 bg-black${failed ? ' hidden' : ''}`}
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-cyan-500/10 px-3 py-2 text-xs text-cyan-200/70">
        <span className="truncate">{tab.name}</span>
        <button
          type="button"
          onClick={() => {
            const shell = window.electronAPI?.shell as ShellBridge | undefined
            void shell?.showItemInFolder?.(tab.path)
          }}
          className="shrink-0 rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-cyan-100 hover:bg-cyan-500/20"
        >
          在文件夹中显示
        </button>
      </div>
    </div>
  )
}
