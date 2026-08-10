import { useRef, useEffect, useState, useCallback } from 'react'
import { useFileExplorerStore } from './store'
import { FileTree } from './FileTree'
import {
  FileTreeIcon,
  CloseIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PanelRightCollapseIcon,
  PanelRightExpandIcon,
} from './icons'
import { FileTabStrip } from './FileTabStrip'
import { LatestPreviewBanner } from './LatestPreviewBanner'
import { FileViewer } from './FileViewer'
import { ImageViewer } from './ImageViewer'
import { toRenderableUri } from './uri'
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
      // 走同一个 helper 而不是手拼:它会把盘符冒号编码成 %3A。手拼出来的
      // `local-file:///D:/x.pdf` 依赖协议处理器从 host 反推盘符那条兼容分支,
      // 而图片/视频用的是编码形式 —— 两种写法并存迟早会有人只修一边。
      return <embed src={toRenderableUri(tab.path)} type="application/pdf" className="h-full w-full" />
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
  const fxCollapsed = useFileExplorerStore((s) => s.fxCollapsed)
  const fxViewerCollapsed = useFileExplorerStore((s) => s.fxViewerCollapsed)
  const toggleFxCollapsed = useFileExplorerStore((s) => s.toggleFxCollapsed)
  const toggleFxViewerCollapsed = useFileExplorerStore((s) => s.toggleFxViewerCollapsed)
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
    // 收起时同样不抢键 —— 面板视觉上不存在,快捷键应回到底下的经典界面。
    if (!fxOpen || fxCollapsed) return undefined
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [fxOpen, fxCollapsed, handleKeyDown])

  if (!fxOpen) return null

  // 「只收查看器」:保留左侧文件树可见可交互,中间查看器列 invisible
  // (保尺寸,tldraw keep-alive 不塌)+ 容器整体不再涂底色/吃鼠标,
  // 让底下经典生图/生视频界面在中间区域完全可见可点。整栏收起优先。
  const viewerOnly = fxViewerCollapsed && !fxCollapsed

  return (
    <>
    <div
      role="region"
      aria-label="File Explorer"
      data-file-explorer-root="true"
      data-collapsed={fxCollapsed ? 'true' : 'false'}
      data-viewer-collapsed={viewerOnly ? 'true' : 'false'}
      aria-hidden={fxCollapsed}
      tabIndex={-1}
      // 收起 = 保持挂载,仅 CSS 滑出左侧。不能走 return null 卸载:tldraw
      // 画布(ViewerHost keep-alive 层)是 agent canvas_* 工具的运行时,
      // 卸载会把 editor 置空,mid-flight 工具调用报 "Canvas is not open"。
      // translateX(-100%) 保住容器尺寸(tldraw viewport 不塌成 0×0),
      // visibility:hidden + pointer-events-none 让底下经典生图/生视频界面
      // 完全可交互。transform 仅在收起时内联注入 —— 展开态不留 transform,
      // 避免给面板内 fixed 定位后代(tldraw 菜单等)造出 containing block。
      style={{
        right: rightOffset,
        ...(fxCollapsed ? { transform: 'translateX(-100%)', visibility: 'hidden' as const } : {}),
      }}
      className={`fixed bottom-0 left-0 top-0 z-[40000] flex flex-col outline-none ${
        viewerOnly
          ? 'pointer-events-none bg-transparent'
          : 'border-r border-cyan-400/25 bg-zinc-950 shadow-[24px_0_80px_rgba(34,211,238,0.16)] backdrop-blur'
      } ${fxCollapsed ? 'pointer-events-none' : ''}`}
    >
      <header
        style={viewerOnly ? { width: fxTreeWidth } : undefined}
        className={`flex h-9 items-center justify-between border-b border-cyan-500/15 px-3 ${
          viewerOnly ? 'pointer-events-auto border-r border-cyan-400/25 bg-zinc-950 backdrop-blur' : ''
        }`}
      >
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-cyan-200/70">
          <FileTreeIcon />
          Files
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="fx-viewer-collapse-button"
            onClick={() => toggleFxViewerCollapsed()}
            className="rounded p-1 text-cyan-300/60 hover:bg-white/5 hover:text-cyan-200"
            aria-label={viewerOnly ? 'Expand viewer' : 'Collapse viewer only'}
            title={viewerOnly ? '展开中间查看器' : '只收中间查看器(保留文件树)'}
          >
            {viewerOnly ? <PanelRightExpandIcon /> : <PanelRightCollapseIcon />}
          </button>
          <button
            type="button"
            data-testid="fx-collapse-button"
            onClick={() => toggleFxCollapsed()}
            className="rounded p-1 text-cyan-300/60 hover:bg-white/5 hover:text-cyan-200"
            aria-label="Collapse file explorer"
            title="收起(画布保持在后台,点左缘把手恢复)"
          >
            <ChevronLeftIcon />
          </button>
          <button
            type="button"
            onClick={() => setFxOpen(false)}
            className="rounded p-1 text-cyan-300/60 hover:bg-white/5 hover:text-cyan-200"
            aria-label="Close file explorer"
            title="Close (Ctrl/Cmd+Shift+I)"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          style={{ width: fxTreeWidth }}
          className={`overflow-hidden border-r ${
            viewerOnly
              ? 'pointer-events-auto border-cyan-400/25 bg-zinc-950 backdrop-blur'
              : 'border-cyan-500/10'
          }`}
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
          className={`w-1 cursor-col-resize hover:bg-cyan-400/30 ${viewerOnly ? 'pointer-events-auto' : ''}`}
        />

        <div
          data-testid="fx-viewer-column"
          aria-hidden={viewerOnly}
          className={`flex min-w-0 flex-1 flex-col ${viewerOnly ? 'pointer-events-none invisible' : ''}`}
        >
          <LatestPreviewBanner />
          <FileTabStrip />
          <div className="min-h-0 flex-1 overflow-auto bg-black/40">
            <ViewerHost />
          </div>
        </div>
      </div>
      <div className={viewerOnly ? 'pointer-events-auto' : undefined}>
        <ConflictModal />
      </div>
    </div>

    {/* 收起后的左缘把手:细长竖条,点击恢复面板。与面板同层 z,面板本体
        已 visibility:hidden,把手是收起态下唯一可命中的浮层元素。 */}
    {fxCollapsed ? (
      <button
        type="button"
        data-testid="fx-collapsed-handle"
        onClick={() => toggleFxCollapsed()}
        aria-label="Expand file explorer"
        title="展开工作区面板"
        className="fixed bottom-0 left-0 top-0 z-[40000] flex w-7 cursor-pointer flex-col items-center justify-center gap-3 border-r border-cyan-400/25 bg-zinc-950/95 text-cyan-300/60 shadow-[8px_0_24px_rgba(34,211,238,0.12)] backdrop-blur transition-colors hover:bg-cyan-400/10 hover:text-cyan-100"
      >
        <ChevronRightIcon />
        <span className="text-[10px] uppercase tracking-[0.25em] [writing-mode:vertical-rl]">Files</span>
      </button>
    ) : null}
    </>
  )
}
