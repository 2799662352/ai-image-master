import type { EditorState } from '@codemirror/state'

export type FileSource = 'workspace' | 'attachments'

export type FileNode = {
  path: string
  name: string
  kind: 'file' | 'dir'
  source: FileSource
  mime?: string
  size?: number
  childrenLoaded?: boolean
  children?: FileNode[]
}

export type FileTabKind = 'text' | 'image' | 'pdf' | 'binary'

export type FileTab = {
  id: string
  path: string
  name: string
  source: FileSource
  kind: FileTabKind
  state: EditorState | null
  diskContent: string
  diskMtime: number
  dirty: boolean
}

export type WatchEvent = { type: 'change' | 'unlink'; path: string; mtime?: number }

export type Conflict = { tabId: string; diskContent: string; show: 'modal' | 'merge' } | null
