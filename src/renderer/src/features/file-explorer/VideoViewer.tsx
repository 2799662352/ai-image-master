import type { FileTab } from './types'
import { useFileUrl } from './useFileUrl'

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

export function VideoViewer({ tab }: { tab: FileTab }) {
  const file = useFileUrl(tab.path)

  return (
    <div className="flex h-full min-h-0 flex-col bg-black/70">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {file.status === 'loading' && (
          <span className="text-sm text-cyan-300/60">加载中…</span>
        )}
        {file.status === 'error' && (
          <span className="text-sm text-red-400">加载失败: {file.reason}</span>
        )}
        {file.status === 'ready' && (
          <video
            src={file.url}
            controls
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
