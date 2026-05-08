import { useState } from 'react'
import type { FileNode } from './types'
import { useFileExplorerStore } from './store'
import { FolderIcon, FolderOpenIcon, FileIcon, ImageFileIcon, ChevronRightIcon } from './icons'
import { serializeFileDrag } from './dragHelpers'

export function FileTreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(node.childrenLoaded === true && (node.children?.length ?? 0) > 0)
  const { expandDir, openTab } = useFileExplorerStore()

  const onClick = async () => {
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
    if (node.kind === 'file') serializeFileDrag(e.dataTransfer, node.path)
  }

  const isImage = node.mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(node.name)
  const Icon = node.kind === 'dir' ? (open ? FolderOpenIcon : FolderIcon) : isImage ? ImageFileIcon : FileIcon

  return (
    <>
      <div
        role="treeitem"
        draggable={node.kind === 'file'}
        onClick={onClick}
        onDragStart={onDragStart}
        style={{ paddingLeft: 8 + depth * 12 }}
        className="flex cursor-pointer select-none items-center gap-1 py-0.5 text-sm text-cyan-100/80 hover:bg-white/5"
      >
        {node.kind === 'dir' && (
          <ChevronRightIcon className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
        )}
        <Icon className="opacity-70" />
        <span className="truncate">{node.name}</span>
      </div>
      {open && node.children?.map((c) => <FileTreeNode key={c.path} node={c} depth={depth + 1} />)}
    </>
  )
}
