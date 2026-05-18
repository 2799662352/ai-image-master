import type { EditorState } from '@codemirror/state'
import type { AgentReference } from '../../../../types/agent-reference'
import type { FileChange } from '../../../../types/agent-timeline'

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

export type FileTabKind = 'text' | 'image' | 'video' | 'pdf' | 'binary' | 'reference' | 'compare' | 'ai-change'

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
  aiChangeKey?: string
  /**
   * For `kind === 'compare'`: the two file paths being compared.
   */
  compare?: { left: string; right: string; leftContent: string; rightContent: string }
  aiChange?: {
    change: FileChange
    beforeContent?: string
    afterContent?: string
    parseError?: string
  }
}

export type WatchEvent = { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string; mtime?: number }

/**
 * `source` distinguishes:
 * - `'watcher'` (default, omitted): disk changed under the user's feet
 *   while they had unsaved edits — UI offers "Keep yours" / "Use disk".
 * - `'apply'`: the user clicked **Apply** on an AI-emitted code block;
 *   `diskContent` is the AI's proposed content. UI swaps to
 *   "Cancel" / "Apply" / "Show diff".
 */
export type Conflict =
  | { tabId: string; diskContent: string; show: 'modal' | 'merge'; source?: 'watcher' | 'apply' }
  | null
