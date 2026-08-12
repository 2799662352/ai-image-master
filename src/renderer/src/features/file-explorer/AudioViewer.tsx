import type { FileTab } from './types'
import { useFileUrl } from './useFileUrl'

/**
 * 音频文件查看器。
 *
 * 此前 mp3/wav 落进 classify 的 `binary` 分支 —— 界面只给一句"二进制文件",连播
 * 都播不了,而应用里到处都在生成配音和音效。
 *
 * 播放链路与 VideoViewer 完全同款:**不能**把磁盘路径直接塞进 `<audio src>`,
 * Windows 上盘符会在自定义协议解析时被吞掉(electron#49073,详见 useFileUrl 模块
 * 注释),所以统一经 IPC 读字节转 blob:。这条纪律有源码级守卫(viewersUseIpc)。
 */

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

export function AudioViewer({ tab }: { tab: FileTab }) {
  const file = useFileUrl(tab.path)

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
        {file.status === 'loading' && <span className="text-sm text-cyan-300/60">加载中…</span>}
        {file.status === 'error' && (
          <span className="text-sm text-red-400">加载失败: {file.reason}</span>
        )}
        {file.status === 'ready' && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio
            src={file.url}
            controls
            preload="metadata"
            controlsList="nodownload"
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
