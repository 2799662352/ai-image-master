import { memo, useEffect, useRef, useState } from 'react'
import type { FileNode, FileSource } from './types'
import { useFileExplorerStore } from './store'
import { FolderIcon, FolderOpenIcon, FileIcon, ImageFileIcon, ChevronRightIcon } from './icons'
import { serializeFileDrag, parseFileDrop, resolveExternalPaths } from './dragHelpers'
import { FileContextMenu, type FileMenuAction, type MenuItemDescriptor } from './FileContextMenu'
import { isAncestorPath } from './revealInExplorer'

// The attachments tree's pseudo-root node has this synthetic path; drops onto
// it would call fs.move with a non-filesystem destDir which assertContained
// rejects. We early-return wherever it would matter.
const ATTACHMENTS_ROOT = '__attachments__'

type ShellBridge = {
  showItemInFolder?: (path: string) => Promise<unknown>
}

function buildMenu(opts: {
  isDir: boolean
  hasClipboard: boolean
  selectionCount: number
  selectionAllFiles: boolean
}): MenuItemDescriptor[] {
  const items: MenuItemDescriptor[] = []
  if (opts.isDir) {
    items.push(
      { id: 'newFile', label: '新建文件' },
      { id: 'newFolder', label: '新建文件夹', separatorAfter: true },
    )
  }
  items.push(
    { id: 'reveal', label: '在文件夹中显示' },
    { id: 'openTerminal', label: '在终端中打开', separatorAfter: true },
    { id: 'cut', label: '剪切', shortcut: 'Ctrl+X' },
    { id: 'copy', label: '复制', shortcut: 'Ctrl+C' },
  )
  if (opts.isDir) {
    items.push({ id: 'paste', label: '粘贴', shortcut: 'Ctrl+V', disabled: !opts.hasClipboard })
  }
  items.push(
    { id: 'copyPath', label: '复制路径', shortcut: 'Shift+Alt+C' },
    { id: 'copyRelativePath', label: '复制相对路径', separatorAfter: true },
  )
  if (opts.selectionCount === 2 && opts.selectionAllFiles) {
    items.push({ id: 'compareSelected', label: '比较选中的两个文件', separatorAfter: true })
  }
  items.push(
    { id: 'rename', label: '重命名', shortcut: 'F2' },
    { id: 'trash', label: '删除（移到回收站）', shortcut: 'Delete', danger: true },
  )
  return items
}

/**
 * 一行一个组件,递归渲染整棵树。
 *
 * `memo` 只有在两件事同时成立时才真的省下东西:
 *  ① `node` 的引用在没改到它时保持不变 —— 由 treeOps 的结构共享保证;
 *  ② 组件订阅的是**派生布尔**而不是 selectedPaths / clipboard 这类每次新建的对象。
 * 少任何一条,memo 都会静默失效:看起来做了优化,实际每行照样重渲染。
 */
export const FileTreeNode = memo(function FileTreeNode({
  node,
  depth,
}: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(node.childrenLoaded === true && (node.children?.length ?? 0) > 0)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(node.name)
  // Tracks whether a drag is currently hovering this row, used to paint a
  // highlight identical to VSCode's "drop target" tint. We can't just use
  // CSS `:hover` because that triggers without an active drag.
  const [dropActive, setDropActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  const expandDir = useFileExplorerStore((s) => s.expandDir)
  const openTab = useFileExplorerStore((s) => s.openTab)
  const trashFile = useFileExplorerStore((s) => s.trashFile)
  const renameFile = useFileExplorerStore((s) => s.renameFile)
  const moveByDnd = useFileExplorerStore((s) => s.moveByDnd)
  const selectNode = useFileExplorerStore((s) => s.selectNode)
  // 订阅**派生出来的布尔值**，而不是 selectedPaths / clipboard / pendingNewNode 本身。
  //
  // 那三个每次都是新引用(selectNode 直接 `selectedPaths: [path]`)，订阅它们等于
  // 「任何一次点击都让每一行重渲染」。订阅布尔之后，一次点击只会重渲染真正变了的
  // 那两行:被取消选中的和被选中的。其余 15 个是 action，zustand 里引用恒定，
  // 不会引起重渲染，留着不动。
  const isSelected = useFileExplorerStore((s) => s.selectedPaths.includes(node.path))
  const isCut = useFileExplorerStore(
    (s) => s.clipboard?.mode === 'cut' && s.clipboard.paths.includes(node.path),
  )
  const copySel = useFileExplorerStore((s) => s.copySelectionToClipboard)
  const cutSel = useFileExplorerStore((s) => s.cutSelectionToClipboard)
  const paste = useFileExplorerStore((s) => s.pasteIntoDir)
  const copyPath = useFileExplorerStore((s) => s.copyPathToOsClipboard)
  const startNewNode = useFileExplorerStore((s) => s.startNewNode)
  const commitNewNode = useFileExplorerStore((s) => s.commitNewNode)
  const cancelNewNode = useFileExplorerStore((s) => s.cancelNewNode)
  const openInTerm = useFileExplorerStore((s) => s.openInTerminal)
  const compareSel = useFileExplorerStore((s) => s.compareSelection)
  // 同理:只关心「新建占位是不是挂在我这一行」，而不是整个 pendingNewNode 对象。
  const newNodeKind = useFileExplorerStore(
    (s) => (s.pendingNewNode?.parentPath === node.path ? s.pendingNewNode.kind : undefined),
  )

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus()
      const dotIdx = node.name.lastIndexOf('.')
      if (dotIdx > 0) inputRef.current.setSelectionRange(0, dotIdx)
      else inputRef.current.select()
    }
  }, [renaming, node.name])

  // 当 dir 节点处于「正在新建」状态且未展开时，自动打开
  useEffect(() => {
    if (newNodeKind && !open && node.kind === 'dir') {
      setOpen(true)
    }
  }, [newNodeKind, node.kind, open])

  // 监听全局 F2 重命名请求（FileExplorerPanel 触发）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail
      if (detail.path === node.path) setRenaming(true)
    }
    window.addEventListener('file-explorer:rename-request', handler)
    return () => window.removeEventListener('file-explorer:rename-request', handler)
  }, [node.path])

  // 监听全局「全部折叠」事件
  useEffect(() => {
    const handler = () => {
      if (node.kind === 'dir') setOpen(false)
    }
    window.addEventListener('file-explorer:collapse-all', handler)
    return () => window.removeEventListener('file-explorer:collapse-all', handler)
  }, [node.kind])

  // 监听「定位到文件」事件（聊天里点击蓝色链接 → store.revealPath 派发）。
  // 命中目标行 → 滚动到可见；是目标的祖先目录 → 自动展开，使深层文件可见。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail
      if (!detail?.path) return
      if (detail.path === node.path) {
        rowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      } else if (node.kind === 'dir' && isAncestorPath(node.path, detail.path)) {
        setOpen(true)
      }
    }
    window.addEventListener('file-explorer:reveal', handler)
    return () => window.removeEventListener('file-explorer:reveal', handler)
  }, [node.path, node.kind])

  const onClick = async (e: React.MouseEvent) => {
    if (renaming) return

    // 多选 modifiers
    if (e.shiftKey) {
      e.preventDefault()
      selectNode(node.path, 'range')
      return
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      selectNode(node.path, 'toggle')
      return
    }

    // 普通点击：替换选择
    selectNode(node.path, 'replace')

    if (node.kind === 'dir') {
      if (!node.childrenLoaded && node.path !== '__attachments__') {
        await expandDir(node.path, node.source)
      }
      setOpen((v) => !v)
      return
    }
    await openTab(node.path, node.source)
  }

  const onDragStart = (e: React.DragEvent) => {
    // Attachments root is a synthetic pseudo-node — refuse to drag it.
    if (node.path === ATTACHMENTS_ROOT) {
      e.preventDefault()
      return
    }
    // VSCode 行为：拖动已选中的节点 → 拖整个选区；
    // 拖动未选中的节点 → 替换选区为该节点（保证拖出的就是用户看到的）。
    // 与旧实现的区别：现在 dir 也可拖，所以 selection 中 file/dir 都保留。
    const store = useFileExplorerStore.getState()
    let paths: string[]
    if (store.selectedPaths.includes(node.path) && store.selectedPaths.length > 1) {
      const trees = [store.workspaceTree, store.attachmentsTree]
      paths = store.selectedPaths.filter((p) => {
        if (p === ATTACHMENTS_ROOT) return false
        const n = findNodeAcrossTrees(trees, p)
        return n != null
      })
    } else {
      paths = [node.path]
      if (!store.selectedPaths.includes(node.path)) {
        store.selectNode(node.path, 'replace')
      }
    }
    if (paths.length === 0) {
      e.preventDefault()
      return
    }
    serializeFileDrag(e.dataTransfer, paths)
    // copyMove tells the OS our payload supports both internal move + external
    // copy; the actual op is chosen by the drop target.
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  // VSCode treats both dirs AND files as valid drop targets — dropping onto a
  // file uses its parent directory as dest. That matches user mental models
  // (everyone has at some point dropped onto README.md hoping to land it in
  // the same folder). We replicate that here.
  const resolveDropDestDir = (): string | null => {
    // v0: workspace tree only. Refuse the attachments header AND any node
    // whose source is 'attachments' (the children). Spec defers attachments
    // drop to v0.2.
    if (node.path === ATTACHMENTS_ROOT) return null
    if (node.source === 'attachments') return null
    if (node.kind === 'dir') return node.path
    const idx = Math.max(node.path.lastIndexOf('/'), node.path.lastIndexOf('\\'))
    return idx > 0 ? node.path.slice(0, idx) : null
  }

  const onDragOver = (e: React.DragEvent) => {
    // Accept either our internal drag MIME (file-explorer → file-explorer move)
    // or an external OS file drop (Desktop / Finder → workspace import).
    const isInternal = e.dataTransfer.types.includes('application/x-catimation-file-paths')
    const isExternal = e.dataTransfer.types.includes('Files')
    if (!isInternal && !isExternal) return
    const dest = resolveDropDestDir()
    if (!dest) {
      // MIME matched but this row cannot accept the drop (e.g. ATTACHMENTS_ROOT
      // header). Absorb the event so it doesn't bubble up to the panel's
      // onRootDrop and silently land in the workspace root.
      e.preventDefault()
      e.stopPropagation()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = isExternal ? 'copy' : 'move'
    if (!dropActive) setDropActive(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    // dragleave fires for every nested element transition — only clear when
    // the cursor truly leaves this row.
    const related = e.relatedTarget as Node | null
    if (related && e.currentTarget.contains(related)) return
    if (dropActive) setDropActive(false)
  }

  const onDrop = async (e: React.DragEvent) => {
    const dest = resolveDropDestDir()
    if (!dest) {
      // Same reason as onDragOver: prevent fall-through to onRootDrop.
      e.preventDefault()
      e.stopPropagation()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)

    // Branch A: external OS file drop.
    if ((e.dataTransfer.files?.length ?? 0) > 0) {
      const externalPaths = resolveExternalPaths(e.dataTransfer.files)
      if (externalPaths.length === 0) return

      const importExternal = useFileExplorerStore.getState().importExternalByDnd
      const res = await importExternal(externalPaths, dest)
      if (!res.ok && res.reason) {
        window.alert(`导入失败: ${res.reason}`)
      }
      return
    }

    // Branch B (existing): internal move via custom MIME.
    const paths = parseFileDrop(e.dataTransfer)
    if (paths.length === 0) return
    const res = await moveByDnd(paths, dest)
    if (!res.ok && res.reason) {
      window.alert(`移动失败: ${res.reason}`)
    }
  }

  const onContextMenu = (e: React.MouseEvent) => {
    if (node.path === '__attachments__') return
    e.preventDefault()
    e.stopPropagation()
    // 若当前节点不在选区，则替换选区为当前节点
    if (!isSelected) selectNode(node.path, 'replace')
    setDraftName(node.name)
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const handleAction = async (action: FileMenuAction) => {
    if (action === 'reveal') {
      const shellApi = (window as Window & { electronAPI?: { shell?: ShellBridge } }).electronAPI?.shell
      void shellApi?.showItemInFolder?.(node.path)
      return
    }
    if (action === 'openTerminal') {
      await openInTerm(node.path)
      return
    }
    if (action === 'newFile' || action === 'newFolder') {
      await startNewNode(node.path, action === 'newFile' ? 'file' : 'dir', node.source)
      return
    }
    if (action === 'cut') {
      cutSel()
      return
    }
    if (action === 'copy') {
      copySel()
      return
    }
    if (action === 'paste') {
      const targetDir = node.kind === 'dir' ? node.path : null
      if (!targetDir) return
      const res = await paste(targetDir)
      if (!res.ok) window.alert(`粘贴失败: ${res.reason ?? 'unknown'}`)
      return
    }
    if (action === 'copyPath') {
      await copyPath(useFileExplorerStore.getState().selectedPaths, false)
      return
    }
    if (action === 'copyRelativePath') {
      await copyPath(useFileExplorerStore.getState().selectedPaths, true)
      return
    }
    if (action === 'rename') {
      setRenaming(true)
      return
    }
    if (action === 'trash') {
      const sel = useFileExplorerStore.getState().selectedPaths
      const count = sel.length || 1
      if (typeof window !== 'undefined' && !window.confirm(`将 ${count} 项移到回收站？`)) return
      // 删除选区里的所有项
      await useFileExplorerStore.getState().trashSelection()
      return
    }
    if (action === 'compareSelected') {
      const res = await compareSel()
      if (!res.ok) window.alert(`比较失败: ${res.reason ?? 'unknown'}`)
      return
    }
  }

  const commitRename = async () => {
    const name = draftName.trim()
    if (!name || name === node.name) {
      setRenaming(false)
      return
    }
    const res = await renameFile(node.path, name)
    if (!res.ok) {
      window.alert(`重命名失败: ${res.reason}`)
      setDraftName(node.name)
    }
    setRenaming(false)
  }

  const cancelRename = () => {
    setDraftName(node.name)
    setRenaming(false)
  }

  const isImage = node.mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(node.name)
  const Icon = node.kind === 'dir' ? (open ? FolderOpenIcon : FolderIcon) : isImage ? ImageFileIcon : FileIcon

  const rowBase = 'flex cursor-pointer select-none items-center gap-1 py-0.5 text-sm'
  const rowState = dropActive
    ? 'bg-cyan-400/25 text-cyan-50 ring-1 ring-cyan-300/40'
    : isSelected
      ? 'bg-cyan-400/15 text-cyan-50'
      : 'text-cyan-100/80 hover:bg-white/5'
  const cutOpacity = isCut ? 'opacity-50' : ''

  // 检查是否要在该节点下渲染「新建占位」
  const showInlineNew = newNodeKind !== undefined && open

  /** 右键菜单要的那几项,开菜单的一刻现读 —— 见下方 FileContextMenu 处的说明。 */
  const menuInputs = (isDir: boolean) => {
    const s = useFileExplorerStore.getState()
    return {
      isDir,
      hasClipboard: !!s.clipboard,
      selectionCount: s.selectedPaths.length,
      selectionAllFiles: areAllSelectedFiles(s.selectedPaths),
    }
  }

  return (
    <>
      <div
        ref={rowRef}
        role="treeitem"
        aria-selected={isSelected || undefined}
        draggable={!renaming && node.path !== ATTACHMENTS_ROOT}
        onClick={(e) => void onClick(e)}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
        onContextMenu={onContextMenu}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={`${rowBase} ${rowState} ${cutOpacity}`}
      >
        {node.kind === 'dir' && (
          <ChevronRightIcon className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
        )}
        <Icon className="opacity-70" />
        {renaming ? (
          <input
            ref={inputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') void commitRename()
              else if (e.key === 'Escape') cancelRename()
            }}
            className="min-w-0 flex-1 rounded border border-cyan-400/40 bg-black/60 px-1 py-0 text-sm text-cyan-50 outline-none focus:border-cyan-300"
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
      </div>

      {showInlineNew && (
        <NewNodeRow
          depth={depth + 1}
          kind={newNodeKind!}
          onCommit={(name) => void commitNewNode(name)}
          onCancel={cancelNewNode}
        />
      )}

      {open && node.children?.map((c) => <FileTreeNode key={c.path} node={c} depth={depth + 1} />)}

      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          // 开菜单时现读,而不是常年订阅 selectedPaths / clipboard。同一时刻只有一行
          // 有菜单,为它让**每一行**都跟着选中集重渲染不划算;而且 areAllSelectedFiles
          // 是对整棵树做 DFS,常驻订阅意味着每次点击都跑一遍。
          items={buildMenu(menuInputs(node.kind === 'dir'))}
          onSelect={(a) => void handleAction(a)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
})

export function NewNodeRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: {
  depth: number
  kind: 'file' | 'dir'
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const Icon = kind === 'dir' ? FolderIcon : FileIcon

  return (
    <div
      role="treeitem"
      style={{ paddingLeft: 8 + depth * 12 }}
      className="flex select-none items-center gap-1 py-0.5 text-sm text-cyan-100/80"
    >
      <Icon className="opacity-70" />
      <input
        ref={ref}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => onCommit(name)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') onCommit(name)
          else if (e.key === 'Escape') onCancel()
        }}
        placeholder={kind === 'dir' ? '新文件夹名' : '新文件名'}
        className="min-w-0 flex-1 rounded border border-cyan-400/40 bg-black/60 px-1 py-0 text-sm text-cyan-50 outline-none focus:border-cyan-300"
      />
    </div>
  )
}

function findNodeAcrossTrees(trees: FileNode[][], target: string): FileNode | null {
  const visit = (nodes: FileNode[]): FileNode | null => {
    for (const n of nodes) {
      if (n.path === target) return n
      if (n.children) {
        const inner = visit(n.children)
        if (inner) return inner
      }
    }
    return null
  }
  for (const tree of trees) {
    const hit = visit(tree)
    if (hit) return hit
  }
  return null
}

function areAllSelectedFiles(paths: string[]): boolean {
  if (paths.length === 0) return false
  const s = useFileExplorerStore.getState()
  const trees = [s.workspaceTree, s.attachmentsTree]
  return paths.every((p) => {
    const node = findNodeAcrossTrees(trees, p)
    return node?.kind === 'file'
  })
}

// re-exported for FileTree to render workspace-root level new node placeholder
export type { FileSource }
