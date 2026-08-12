import { useState } from 'react'
import type { FileTab } from './types'
import { toStreamableUri } from './uri'
import { describeMediaError } from './mediaError'

/**
 * 视频查看器 —— 走 `local-file://` **流式**协议,不再把整份文件读进内存。
 *
 * 此前这里用 useFileUrl:IPC 读全文件 → base64 回渲染端 → `fetch('data:…')` 转 blob。
 * 一个成片 mp4 走这条路会连撞三堵墙:`attachments:read-thumb` 的 100MB 上限先把它
 * 挡回去、回落到 `fs:read-binary` 后整份 base64(再胖三分之一)跨进程、最后那个
 * 一两百 MB 的 data: URL 让 Chromium 的 fetch 直接放弃 —— 界面上就是
 * 「加载失败: TypeError: Failed to fetch」。能放出来的那些也没有 Range,进度条拖不动,
 * 而且整份解码都压在渲染进程内存里。
 *
 * 现在交给 `protocol.handle('local-file')`(见 main/file-explorer/protocolHandler.ts):
 * Electron 内部是 `createReadStream` + `Readable.toWeb`,按需吐字节、原生支持 Range,
 * 不进内存也能 seek。这正是官方文档给的做法(protocol.handle + net.fetch(pathToFileURL))。
 *
 * 地址形状是 `local-file://media/?p=<编码后的绝对路径>`:host 必须非空(标准 scheme
 * 的空 host 会被 `IsSafeToLoadURL` 直接判死,连请求都不发),路径塞在查询串里不参与
 * 路径规范化,盘符不会被折叠。详见 uri.ts 的 toStreamableUri。
 *
 * **图片仍走 useFileUrl**。它体积小、blob 那条路稳定,而且此处没有 Range 可言 ——
 * 换过去只是白冒风险。这条分工写在 viewersUseIpc 守卫测试里。
 */

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

export function VideoViewer({ tab }: { tab: FileTab }) {
  const src = toStreamableUri(tab.path)
  // 换文件时清掉上一份的失败态,否则上一个坏文件会把新标签页也标成失败。
  const [failure, setFailure] = useState<{ src: string; reason: string } | null>(null)
  const failed = failure?.src === src

  return (
    <div className="flex h-full min-h-0 flex-col bg-black/70">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {failed ? (
          // 把 MediaError 的码摆出来:它把「传输没通」「编码解不了」「中途断流」
          // 分得很开,而这三种在界面上长得一模一样。见 mediaError.ts。
          <div className="max-w-lg space-y-2 text-center">
            <div className="text-sm text-red-400">无法播放这个文件</div>
            <div className="text-xs text-red-300/80">{failure?.reason}</div>
            <div className="break-all font-mono text-[10px] text-white/35">{src}</div>
          </div>
        ) : (
          <video
            key={src}
            src={src}
            controls
            preload="metadata"
            onError={(e) => setFailure({ src, reason: describeMediaError(e.currentTarget) })}
            className="max-h-full max-w-full rounded border border-cyan-500/20 bg-black"
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
