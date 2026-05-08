import type { FileTab } from './types'

type ShellWithReveal = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

export function BinaryViewer({ tab }: { tab: FileTab }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm rounded border border-cyan-500/30 p-6 text-center text-cyan-200/80">
        <div className="mb-1 text-sm font-medium">{tab.name}</div>
        <div className="mb-4 text-xs text-cyan-300/40">Binary file - preview not available</div>
        <button
          type="button"
          onClick={() => {
            const shell = window.electronAPI?.shell as ShellWithReveal | undefined
            void shell?.showItemInFolder?.(tab.path)
          }}
          className="rounded border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-100 hover:bg-cyan-500/20"
        >
          Reveal in OS
        </button>
      </div>
    </div>
  )
}
