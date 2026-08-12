import { useState } from 'react'
import type { FileTab } from './types'
import { toStreamableUri } from './uri'
import { describeMediaError } from './mediaError'

/**
 * 音频文件查看器。
 *
 * 此前 mp3/wav 落进 classify 的 `binary` 分支 —— 界面只给一句「二进制文件」,连播
 * 都播不了,而应用里到处都在生成配音和音效。
 *
 * 播放与 VideoViewer 同链:`local-file://` 流式协议(`protocol.handle` + `net.fetch`
 * + `stream: true`),不把整份文件读进内存,长音频也能拖进度条。音频作品库
 * (main/services/audioHistoryFiles.ts)早就在用这条路,这里只是把文件面板接上。
 *
 * 地址形状 `local-file://media/?p=<编码后的绝对路径>` —— host 非空是关键,路径走查询串
 * 不会被路径规范化动到(详见 uri.ts 的 toStreamableUri)。
 */

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

export function AudioViewer({ tab }: { tab: FileTab }) {
  const src = toStreamableUri(tab.path)
  const [failure, setFailure] = useState<{ src: string; reason: string } | null>(null)
  const failed = failure?.src === src

  return (
    <div className="flex h-full min-h-0 flex-col bg-black/70">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6">
        <div
          aria-hidden
          className="flex h-20 w-20 items-center justify-center rounded-full border border-cyan-500/25 bg-cyan-500/10 text-3xl"
        >
          🎵
        </div>
        <div className="max-w-full truncate text-sm text-cyan-100/90" title={tab.path}>
          {tab.name}
        </div>
        {failed ? (
          <div className="max-w-lg space-y-2 text-center">
            <div className="text-sm text-red-400">无法播放这个文件</div>
            <div className="text-xs text-red-300/80">{failure?.reason}</div>
            <div className="break-all font-mono text-[10px] text-white/35">{src}</div>
          </div>
        ) : (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio
            key={src}
            src={src}
            controls
            preload="metadata"
            controlsList="nodownload"
            onError={(e) => setFailure({ src, reason: describeMediaError(e.currentTarget) })}
            data-testid="fx-audio-player"
            className="w-[min(420px,100%)]"
          />
        )}
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
