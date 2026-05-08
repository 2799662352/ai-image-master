import type { EditorState } from '@codemirror/state'
import type { AgentReference } from '../../../../types/agent-reference'

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

export type FileTabKind = 'text' | 'image' | 'pdf' | 'binary' | 'reference'

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
  /**
   * Synthetic reference tabs keep `path` empty so file watcher events cannot
   * accidentally match them as real filesystem tabs.
   */
  referenceKey?: string
  reference?: AgentReference
}

export type WatchEvent = { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string; mtime?: number }

export type Conflict = { tabId: string; diskContent: string; show: 'modal' | 'merge' } | null
