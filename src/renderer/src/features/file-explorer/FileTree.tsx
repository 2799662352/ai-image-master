import { useEffect } from 'react'
import { useFileExplorerStore } from './store'
import { FileTreeNode } from './FileTreeNode'
import { FolderIcon } from './icons'

export function FileTree() {
  const { workspaceRoot, workspaceTree, attachmentsTree, pickWorkspaceFolder, refreshAttachmentsTree } =
    useFileExplorerStore()

  useEffect(() => {
    void refreshAttachmentsTree()
  }, [refreshAttachmentsTree])

  return (
    <div role="tree" className="flex h-full flex-col gap-2 overflow-auto py-2 text-cyan-100/80">
      <div>
        <div className="px-2 text-xs uppercase tracking-wider text-cyan-300/50">Workspace</div>
        {workspaceRoot && workspaceTree.length > 0 ? (
          workspaceTree.map((n) => <FileTreeNode key={n.path} node={n} depth={0} />)
        ) : (
          <div className="flex flex-col items-center gap-2 py-6 text-xs text-cyan-300/40">
            <FolderIcon className="opacity-50" />
            <div>No folder open</div>
            <button
              type="button"
              onClick={() => void pickWorkspaceFolder()}
              className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-cyan-200 hover:bg-cyan-500/20"
            >
              Open folder…
            </button>
          </div>
        )}
      </div>

      <div>
        <div className="px-2 text-xs uppercase tracking-wider text-cyan-300/50">Attachments</div>
        {attachmentsTree.map((n) => <FileTreeNode key={n.path} node={n} depth={0} />)}
      </div>
    </div>
  )
}
