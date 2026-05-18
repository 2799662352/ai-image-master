import { useEffect, useCallback } from 'react'
import { useFileExplorerStore } from './store'
import { FileTreeNode } from './FileTreeNode'
import { CloseIcon, FolderIcon, FileIcon } from './icons'
import type { FileNode } from './types'

function NewFileGlyph() {
  return <FileIcon className="opacity-70" />
}
function NewFolderGlyph() {
  return <FolderIcon className="opacity-70" />
}
function CollapseAllGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M3 5 L7 9 L11 5" />
      <path d="M3 9 L7 13 L11 9" opacity="0.5" />
    </svg>
  )
}

export function FileTree() {
  const workspaceRoot = useFileExplorerStore((s) => s.workspaceRoot)
  const workspaceTree = useFileExplorerStore((s) => s.workspaceTree)
  const attachmentsTree = useFileExplorerStore((s) => s.attachmentsTree)
  const loadWorkspaceFolders = useFileExplorerStore((s) => s.loadWorkspaceFolders)
  const pickWorkspaceFolder = useFileExplorerStore((s) => s.pickWorkspaceFolder)
  const removeWorkspaceFolder = useFileExplorerStore((s) => s.removeWorkspaceFolder)
  const refreshAttachmentsTree = useFileExplorerStore((s) => s.refreshAttachmentsTree)
  const ensureSubscriptions = useFileExplorerStore((s) => s.ensureSubscriptions)
  const startNewNode = useFileExplorerStore((s) => s.startNewNode)
  const selectedPaths = useFileExplorerStore((s) => s.selectedPaths)
  const clipboard = useFileExplorerStore((s) => s.clipboard)

  useEffect(() => {
    // First-paint pull. After this, the live attachments:changed IPC bridge
    // (set up by ensureSubscriptions) keeps the panel in sync. Without that
    // bridge the panel froze on whatever was visible at mount and never
    // reflected new chat uploads — the bug being fixed here.
    ensureSubscriptions()
    void refreshAttachmentsTree()
  }, [ensureSubscriptions, refreshAttachmentsTree])

  useEffect(() => {
    if (workspaceRoot && workspaceTree.length === 0) void loadWorkspaceFolders()
  }, [loadWorkspaceFolders, workspaceRoot, workspaceTree.length])

  const startAtRoot = useCallback(
    (kind: 'file' | 'dir') => {
      // 优先在选中的目录下创建；否则在第一个 workspace 根目录下
      const sel = selectedPaths[0]
      let parent: string | null = null
      let source: 'workspace' | 'attachments' = 'workspace'
      if (sel) {
        const node = findNode(workspaceTree, sel) ?? findNode(attachmentsTree, sel)
        if (node) {
          source = node.source
          parent = node.kind === 'dir' ? node.path : parentDir(node.path)
        }
      }
      if (!parent && workspaceTree[0]) {
        parent = workspaceTree[0].path
        source = 'workspace'
      }
      if (parent) void startNewNode(parent, kind, source)
    },
    [selectedPaths, workspaceTree, attachmentsTree, startNewNode],
  )

  return (
    <div role="tree" className="flex h-full flex-col gap-2 overflow-auto py-2 text-cyan-100/80">
      <div>
        <div className="flex items-center justify-between px-2 text-xs uppercase tracking-wider text-cyan-300/50">
          <span>Workspace</span>
          <div className="flex items-center gap-1 normal-case tracking-normal">
            <button
              type="button"
              onClick={() => startAtRoot('file')}
              title="新建文件"
              aria-label="新建文件"
              className="rounded p-1 text-cyan-200/70 hover:bg-cyan-500/10 hover:text-cyan-100"
            >
              <NewFileGlyph />
            </button>
            <button
              type="button"
              onClick={() => startAtRoot('dir')}
              title="新建文件夹"
              aria-label="新建文件夹"
              className="rounded p-1 text-cyan-200/70 hover:bg-cyan-500/10 hover:text-cyan-100"
            >
              <NewFolderGlyph />
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('file-explorer:collapse-all'))}
              title="折叠全部"
              aria-label="折叠全部"
              className="rounded p-1 text-cyan-200/70 hover:bg-cyan-500/10 hover:text-cyan-100"
            >
              <CollapseAllGlyph />
            </button>
            {workspaceTree.length > 0 && (
              <button
                type="button"
                onClick={() => void pickWorkspaceFolder()}
                className="rounded border border-cyan-500/20 px-1.5 py-0.5 text-cyan-200 hover:bg-cyan-500/10"
              >
                Add folder…
              </button>
            )}
          </div>
        </div>
        {/* 剪贴板提示 */}
        {clipboard && (
          <div className="mx-2 my-1 rounded border border-cyan-500/15 bg-cyan-500/5 px-2 py-1 text-[10px] text-cyan-300/70">
            剪贴板：{clipboard.mode === 'cut' ? '已剪切' : '已复制'} {clipboard.paths.length} 项
          </div>
        )}
        {workspaceRoot && workspaceTree.length > 0 ? (
          <>
            {workspaceTree.map((n) => (
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
            ))}
            {/*
              All inline new-node inputs are owned by FileTreeNode (it knows
              the correct depth + parent context for both root nodes and
              arbitrarily-deep subdirs). A previous fallback here used
              `workspaceTree.every(n => n.path !== parentPath)`, which only
              compared root paths and therefore matched ANY subdirectory —
              spawning a second NewNodeRow at the panel bottom. Its empty
              <input> stole focus, triggered onBlur on the real input, which
              fired commitNewNode('') and silently cleared pendingNewNode,
              so creating files/folders in subdirectories appeared broken.
              VS Code's tree puts the input at the exact target node; we
              match that here by deleting the fallback entirely.
            */}
          </>
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

function findNode(tree: FileNode[], target: string): FileNode | null {
  for (const n of tree) {
    if (n.path === target) return n
    if (n.children) {
      const inner = findNode(n.children, target)
      if (inner) return inner
    }
  }
  return null
}

function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx > 0 ? p.slice(0, idx) : p
}
