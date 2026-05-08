import { useEffect } from 'react'
import { useFileExplorerStore } from './store'
import { FileTreeNode } from './FileTreeNode'
import { CloseIcon, FolderIcon } from './icons'

export function FileTree() {
  const { workspaceRoot, workspaceTree, attachmentsTree, loadWorkspaceFolders, pickWorkspaceFolder, removeWorkspaceFolder, refreshAttachmentsTree } =
    useFileExplorerStore()

  useEffect(() => {
    void refreshAttachmentsTree()
  }, [refreshAttachmentsTree])

  useEffect(() => {
    if (workspaceRoot && workspaceTree.length === 0) void loadWorkspaceFolders()
  }, [loadWorkspaceFolders, workspaceRoot, workspaceTree.length])

  return (
    <div role="tree" className="flex h-full flex-col gap-2 overflow-auto py-2 text-cyan-100/80">
      <div>
        <div className="flex items-center justify-between px-2 text-xs uppercase tracking-wider text-cyan-300/50">
          <span>Workspace</span>
          {workspaceTree.length > 0 && (
            <button
              type="button"
              onClick={() => void pickWorkspaceFolder()}
              className="rounded border border-cyan-500/20 px-1.5 py-0.5 normal-case tracking-normal text-cyan-200 hover:bg-cyan-500/10"
            >
              Add folder…
            </button>
          )}
        </div>
        {workspaceRoot && workspaceTree.length > 0 ? (
          workspaceTree.map((n) => (
            <div key={n.path} className="group/root relative">
              <FileTreeNode node={n} depth={0} />
              <button
                type="button"
                aria-label={`Remove folder ${n.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  removeWorkspaceFolder(n.path)
                }}
                className="absolute right-1 top-0.5 rounded p-0.5 text-cyan-300/30 opacity-0 hover:bg-white/10 hover:text-cyan-100 group-hover/root:opacity-100"
              >
                <CloseIcon />
              </button>
            </div>
          ))
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
