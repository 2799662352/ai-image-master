import { useState } from 'react'
import { useFileExplorerStore } from './store'
import { DiffMergeView } from './DiffMergeView'

export function ConflictModal() {
  const { conflict, tabs, applyExternalChange } = useFileExplorerStore()
  const [showDiff, setShowDiff] = useState(false)
  if (!conflict) return null
  const tab = tabs.find((t) => t.id === conflict.tabId)
  if (!tab) return null
  const myContent = tab.state?.doc.toString() ?? tab.diskContent
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
      <div className={'rounded border border-cyan-500/30 bg-zinc-900 p-4 ' + (showDiff ? 'h-[80vh] w-[90vw]' : 'w-[420px]')}>
        <div className="mb-3 text-sm text-cyan-100">
          <strong>{tab.name}</strong> changed on disk while you have unsaved edits.
        </div>
        {showDiff && (
          <div className="mb-3 h-[calc(80vh-150px)] rounded border border-cyan-500/20">
            <DiffMergeView disk={conflict.diskContent} mine={myContent} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => void applyExternalChange(tab.id, 'mine')}
            className="rounded bg-white/5 px-3 py-1 text-xs text-cyan-100 hover:bg-white/10"
          >
            Keep yours
          </button>
          <button
            type="button"
            onClick={() => void applyExternalChange(tab.id, 'disk')}
            className="rounded border border-cyan-500/30 bg-cyan-500/20 px-3 py-1 text-xs text-cyan-100 hover:bg-cyan-500/30"
          >
            Use disk
          </button>
          {!showDiff && (
            <button
              type="button"
              onClick={() => setShowDiff(true)}
              className="rounded bg-white/5 px-3 py-1 text-xs text-cyan-200 hover:bg-white/10"
            >
              Show diff
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
