import { useRef, useEffect, useState, useCallback } from 'react'
import { useFileExplorerStore } from './store'
import { FileTree } from './FileTree'
import { FileTreeIcon, CloseIcon } from './icons'
import { FileTabStrip } from './FileTabStrip'
import { LatestPreviewBanner } from './LatestPreviewBanner'
import { FileViewer } from './FileViewer'
import { ImageViewer } from './ImageViewer'
import { VideoViewer } from './VideoViewer'
import { BinaryViewer } from './BinaryViewer'
import { ConflictModal } from './ConflictModal'
import { ReferencePreview } from './ReferencePreview'
import { DiffMergeView } from './DiffMergeView'
import { AiChangeViewer } from './AiChangeViewer'
import { CanvasSection } from '../agent-workspace/CanvasSection'
import { resolveExternalPaths } from './dragHelpers'
import type { FileNode, FileTab } from './types'

function findNodeFlat(tree: FileNode[], target: string): FileNode | null {
  for (const n of tree) {
    if (n.path === target) return n
    if (n.children) {
      const inner = findNodeFlat(n.children, target)
      if (inner) return inner
    }
  }
  return null
}

function collectVisibleFlatNonExported(tree: FileNode[], target: string): FileNode | null {
  return findNodeFlat(tree, target)
}

function parentDirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx > 0 ? p.slice(0, idx) : p
}

/**
 * Center display host. The canvas gets KEEP-ALIVE treatment: once its tab
 * exists, <CanvasSection> stays MOUNTED for the tab's whole lifetime and is
 * merely hidden with CSS (`invisible` = visibility:hidden, dims preserved)
 * while another tab is active. Rationale: the tldraw editor instance is the
 * backing runtime for every agent canvas_* tool (canvasBridge.setEditor in
 * CanvasSection's onMount); the old switch-based ActiveViewer unmounted the
 * component whenever the user viewed another file, which nulled the editor and
 * made mid-flight agent tool calls fail with "Canvas is not open" (a pure
 * mount-lifecycle race, not a tldraw limitation). `visibility:hidden` rather
 * than display:none keeps the container's size so the tldraw viewport/camera
 * don't collapse to 0×0 while hidden; pointer-events-none + aria-hidden keep
 * the hidden layer inert. Unmount (and canvasBridge.setEditor(null)) now only
 * happens when the canvas tab itself is CLOSED.
 */
export function ViewerHost() {
  const { tabs, activeTabId } = useFileExplorerStore()
  const canvasTab = tabs.find((t) => t.kind === 'canvas')
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const canvasActive = activeTab?.kind === 'canvas'
  return (
    <div className="relative h-full">
      {canvasTab && (
        <div
          data-testid="canvas-keepalive"
          aria-hidden={!canvasActive}
          className={canvasActive ? 'absolute inset-0' : 'pointer-events-none invisible absolute inset-0'}
        >
          <CanvasSection />
        </div>
      )}
      {!canvasActive && <ActiveViewer tab={activeTab} />}
    </div>
  )
}

function ActiveViewer({ tab }: { tab: FileTab | undefined }) {
  if (!tab) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-cyan-300/30">
        Open a file to begin
      </div>
    )
  }
  switch (tab.kind) {
    case 'text':
      return <FileViewer tab={tab} />
    case 'image':
      return <ImageViewer tab={tab} />
    case 'video':
      return <VideoViewer tab={tab} />
    case 'pdf':
      return <embed src={`local-file:///${tab.path.replace(/\\/g, '/')}`} type="application/pdf" className="h-full w-full" />
    case 'binary':
      return <BinaryViewer tab={tab} />
    case 'reference':
      return tab.reference ? <ReferencePreview reference={tab.reference} /> : null
    case 'compare':
      if (!tab.compare) return null
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-3 border-b border-cyan-500/10 px-3 py-1.5 text-[11px] text-cyan-200/70">
            <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-cyan-100">A</span>
            <span className="truncate" title={tab.compare.left}>{tab.compare.left}</span>
            <span className="text-cyan-400/70">↔</span>
            <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-cyan-100">B</span>
            <span className="truncate" title={tab.compare.right}>{tab.compare.right}</span>
          </div>
          <div className="min-h-0 flex-1">
            <DiffMergeView disk={tab.compare.leftContent} mine={tab.compare.rightContent} />
          </div>
        </div>
      )
    case 'ai-change':
      return <AiChangeViewer tab={tab} />
    case 'canvas':
      // Rendered by ViewerHost's keep-alive layer, never through this switch.
      return null
  }
}

export function FileExplorerPanel({ rightOffset }: { rightOffset: number }) {
  const fxOpen = useFileExplorerStore((s) => s.fxOpen)
  const fxTreeWidth = useFileExplorerStore((s) => s.fxTreeWidth)
  const setFxTreeWidth = useFileExplorerStore((s) => s.setFxTreeWidth)
  const setFxOpen = useFileExplorerStore((s) => s.setFxOpen)
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)

  useEffect(() => {
    if (!dragging) return undefined
    const onMove = (e: MouseEvent) => setFxTreeWidth(startW.current + (e.clientX - startX.current))
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, setFxTreeWidth])

  const workspaceRoot = useFileExplorerStore((s) => s.workspaceRoot)
  const importExternalByDnd = useFileExplorerStore((s) => s.importExternalByDnd)

  const onRootDragOver = (e: React.DragEvent): void => {
    // Only respond to external file drops; internal-drag inside the tree is
    // handled by individual FileTreeNodes (which call stopPropagation, so we
    // never see those events here unless they fall through the gap).
    if (!e.dataTransfer.types.includes('Files')) return
    if (!workspaceRoot) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onRootDrop = async (e: React.DragEvent): Promise<void> => {
    // Inner FileTreeNode drops always call e.stopPropagation(), so they
    // never reach this handler. The e.defaultPrevented check is
    // defense-in-depth for edge cases (3rd-party handlers, future refactors).
    if (e.defaultPrevented) return
    if ((e.dataTransfer.files?.length ?? 0) === 0) return
    if (!workspaceRoot) return
    const paths = resolveExternalPaths(e.dataTransfer.files)
    if (paths.length === 0) return
    e.preventDefault()
    const res = await importExternalByDnd(paths, workspaceRoot)
    if (!res.ok && res.reason) {
      window.alert(`导入失败: ${res.reason}`)
    }
  }

  // VSCode 风格快捷键 — 全局监听，靠 selectedPaths 守卫避免跟其他区域冲突
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    // 编辑态（输入框/textarea）让原生处理，不抢键
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    const store = useFileExplorerStore.getState()
    // 没选中任何文件时，不抢任何键（让 Ctrl+C/V 等照旧给编辑器/全局用）
    if (store.selectedPaths.length === 0) {
      // 但是 Escape / 方向键也不响应
      return
    }
    const sel = store.selectedPaths
    const ctrlOrMeta = e.ctrlKey || e.metaKey
    const altKey = e.altKey
    const shiftKey = e.shiftKey

    // F2 重命名
    if (e.key === 'F2' && sel.length === 1) {
      e.preventDefault()
      // 通过模拟一次 contextmenu rename 不易，这里改为 dispatch 全局事件
      window.dispatchEvent(new CustomEvent('file-explorer:rename-request', { detail: { path: sel[0] } }))
      return
    }
    // Delete 移到回收站
    if ((e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) && sel.length > 0) {
      e.preventDefault()
      if (window.confirm(`将 ${sel.length} 项移到回收站？`)) void store.trashSelection()
      return
    }
    // Ctrl/Cmd + A 全选可见
    if (ctrlOrMeta && !shiftKey && !altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      store.selectAllVisible(store.collectVisiblePaths())
      return
    }
    // Ctrl/Cmd + C 复制
    if (ctrlOrMeta && !shiftKey && !altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault()
      store.copySelectionToClipboard()
      return
    }
    // Ctrl/Cmd + X 剪切
    if (ctrlOrMeta && !shiftKey && !altKey && (e.key === 'x' || e.key === 'X')) {
      e.preventDefault()
      store.cutSelectionToClipboard()
      return
    }
    // Ctrl/Cmd + V 粘贴 — 目标 = 选中目录或选中文件所在目录
    if (ctrlOrMeta && !shiftKey && !altKey && (e.key === 'v' || e.key === 'V')) {
      if (!store.clipboard || sel.length === 0) return
      e.preventDefault()
      const anchor = sel[0]
      const inWs = collectVisibleFlatNonExported(store.workspaceTree, anchor)
      const node = inWs ?? collectVisibleFlatNonExported(store.attachmentsTree, anchor)
      const targetDir = node?.kind === 'dir' ? node.path : node ? parentDirOf(node.path) : null
      if (targetDir) void store.pasteIntoDir(targetDir)
      return
    }
    // Shift+Alt+C 复制绝对路径
    if (shiftKey && altKey && (e.key === 'c' || e.key === 'C') && sel.length > 0) {
      e.preventDefault()
      void store.copyPathToOsClipboard(sel, false)
      return
    }
    // 上/下方向键导航
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !ctrlOrMeta) {
      const visible = store.collectVisiblePaths()
      if (visible.length === 0) return
      e.preventDefault()
      const cur = sel[sel.length - 1]
      const idx = cur ? visible.indexOf(cur) : -1
      const nextIdx =
        idx < 0
          ? 0
          : e.key === 'ArrowDown'
            ? Math.min(idx + 1, visible.length - 1)
            : Math.max(idx - 1, 0)
      const nextPath = visible[nextIdx]
      store.selectNode(nextPath, shiftKey ? 'range' : 'replace')
      return
    }
    // Enter 打开
    if (e.key === 'Enter' && sel.length === 1) {
      const path = sel[0]
      const node = findNodeFlat(store.workspaceTree, path) ?? findNodeFlat(store.attachmentsTree, path)
      if (!node) return
      e.preventDefault()
      if (node.kind === 'file') void store.openTab(node.path, node.source)
      else void store.expandDir(node.path, node.source)
      return
    }
    // Escape 清除选择
    if (e.key === 'Escape') {
      store.clearSelection()
      return
    }
  }, [])

  useEffect(() => {
    if (!fxOpen) return undefined
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [fxOpen, handleKeyDown])

  if (!fxOpen) return null

  return (
    <div
      role="region"
      aria-label="File Explorer"
      data-file-explorer-root="true"
      tabIndex={-1}
      style={{ right: rightOffset }}
      className="fixed bottom-0 left-0 top-0 z-[40000] flex flex-col border-r border-cyan-400/25 bg-zinc-950 shadow-[24px_0_80px_rgba(34,211,238,0.16)] backdrop-blur outline-none"
    >
      <header className="flex h-9 items-center justify-between border-b border-cyan-500/15 px-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-cyan-200/70">
          <FileTreeIcon />
          Files
        </div>
        <button
          type="button"
          onClick={() => setFxOpen(false)}
          className="rounded p-1 text-cyan-300/60 hover:bg-white/5 hover:text-cyan-200"
          aria-label="Close file explorer"
          title="Close (Ctrl/Cmd+Shift+I)"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          style={{ width: fxTreeWidth }}
          className="overflow-hidden border-r border-cyan-500/10"
          onDragOver={onRootDragOver}
          onDrop={(e) => void onRootDrop(e)}
        >
          <FileTree />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(e) => {
            startX.current = e.clientX
            startW.current = fxTreeWidth
            setDragging(true)
          }}
          className="w-1 cursor-col-resize hover:bg-cyan-400/30"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <LatestPreviewBanner />
          <FileTabStrip />
          <div className="min-h-0 flex-1 overflow-auto bg-black/40">
            <ViewerHost />
          </div>
        </div>
      </div>
      <ConflictModal />
    </div>
  )
}
