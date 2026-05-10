import { useEffect, useRef, useState } from 'react'
import type { FileNode, FileSource } from './types'
import { useFileExplorerStore } from './store'
import { FolderIcon, FolderOpenIcon, FileIcon, ImageFileIcon, ChevronRightIcon } from './icons'
import { serializeFileDrag } from './dragHelpers'
import { FileContextMenu, type FileMenuAction, type MenuItemDescriptor } from './FileContextMenu'

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

export function FileTreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(node.childrenLoaded === true && (node.children?.length ?? 0) > 0)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(node.name)
  const inputRef = useRef<HTMLInputElement>(null)

  const expandDir = useFileExplorerStore((s) => s.expandDir)
  const openTab = useFileExplorerStore((s) => s.openTab)
  const trashFile = useFileExplorerStore((s) => s.trashFile)
  const renameFile = useFileExplorerStore((s) => s.renameFile)
  const selectNode = useFileExplorerStore((s) => s.selectNode)
  const selectedPaths = useFileExplorerStore((s) => s.selectedPaths)
  const clipboard = useFileExplorerStore((s) => s.clipboard)
  const copySel = useFileExplorerStore((s) => s.copySelectionToClipboard)
  const cutSel = useFileExplorerStore((s) => s.cutSelectionToClipboard)
  const paste = useFileExplorerStore((s) => s.pasteIntoDir)
  const copyPath = useFileExplorerStore((s) => s.copyPathToOsClipboard)
  const startNewNode = useFileExplorerStore((s) => s.startNewNode)
  const commitNewNode = useFileExplorerStore((s) => s.commitNewNode)
  const cancelNewNode = useFileExplorerStore((s) => s.cancelNewNode)
  const openInTerm = useFileExplorerStore((s) => s.openInTerminal)
  const compareSel = useFileExplorerStore((s) => s.compareSelection)
  const pendingNewNode = useFileExplorerStore((s) => s.pendingNewNode)

  const isSelected = selectedPaths.includes(node.path)
  const isCut = clipboard?.mode === 'cut' && clipboard.paths.includes(node.path)

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
    if (pendingNewNode?.parentPath === node.path && !open && node.kind === 'dir') {
      setOpen(true)
    }
  }, [pendingNewNode, node.path, node.kind, open])

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
    if (node.kind !== 'file') return
    // VSCode 行为：拖动已选中的节点 → 拖整个选区里的文件；
    // 拖动未选中的节点 → 替换选区为该节点（保证拖出的就是用户看到的）
    const store = useFileExplorerStore.getState()
    let paths: string[]
    if (store.selectedPaths.includes(node.path) && store.selectedPaths.length > 1) {
      // 只拖文件，过滤掉目录（attachments 根这种伪节点也会被排除）
      const trees = [store.workspaceTree, store.attachmentsTree]
      paths = store.selectedPaths.filter((p) => {
        const n = findNodeAcrossTrees(trees, p)
        return n?.kind === 'file'
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
    // 让浏览器在拖影上显示数量（多选时尤其有用）
    if (paths.length > 1 && e.dataTransfer.setDragImage) {
      // 不重写 drag image，仅设置 effectAllowed 与浏览器默认数字徽章
      e.dataTransfer.effectAllowed = 'copyMove'
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
  const rowState = isSelected
    ? 'bg-cyan-400/15 text-cyan-50'
    : 'text-cyan-100/80 hover:bg-white/5'
  const cutOpacity = isCut ? 'opacity-50' : ''

  // 检查是否要在该节点下渲染「新建占位」
  const showInlineNew = pendingNewNode?.parentPath === node.path && open

  return (
    <>
      <div
        role="treeitem"
        aria-selected={isSelected || undefined}
        draggable={node.kind === 'file' && !renaming}
        onClick={(e) => void onClick(e)}
        onDragStart={onDragStart}
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
          kind={pendingNewNode!.kind}
          onCommit={(name) => void commitNewNode(name)}
          onCancel={cancelNewNode}
        />
      )}

      {open && node.children?.map((c) => <FileTreeNode key={c.path} node={c} depth={depth + 1} />)}

      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenu({
            isDir: node.kind === 'dir',
            hasClipboard: !!clipboard,
            selectionCount: selectedPaths.length,
            selectionAllFiles: areAllSelectedFiles(selectedPaths),
          })}
          onSelect={(a) => void handleAction(a)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

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
