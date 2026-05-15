import { create } from 'zustand'
import type { EditorState } from '@codemirror/state'
import type { AgentReference } from '../../../../types/agent-reference'
import type { FileChange } from '../../../../types/agent-timeline'
import type { Conflict, FileNode, FileSource, FileTab } from './types'
import { parseUnifiedDiff } from '../agent-chat/diff/parseUnifiedDiff'
import { classify } from './classify'

const FX_WIDTH_KEY = 'agent-chat:fx-tree-width'
const FX_WORKSPACE_KEY = 'agent-chat:fx-workspace-root'
const FX_OPEN_KEY = 'agent-chat:fx-open'

const clampWidth = (w: number): number => Math.max(200, Math.min(360, w))

type ElectronFileApi = {
  agent?: {
    setAllowedRoots?: (roots: string[]) => Promise<string[]>
  }
  fs: {
    readText: (p: string) => Promise<{ content: string; mtime: number }>
    writeText: (p: string, content: string) => Promise<{ mtime: number }>
    listDir: (p: string) => Promise<FileNode[]>
    stat: (p: string) => Promise<
      | { ok: true; size: number; mime: string; mtime: number }
      | { ok: false; reason?: string }
    >
    pickFolder: () => Promise<string | null>
    watchStart: (p: string) => Promise<void>
    watchStop: (p: string) => Promise<void>
    trash?: (p: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    rename?: (oldPath: string, newName: string) => Promise<{ ok: true; newPath: string } | { ok: false; reason: string }>
    createFile?: (parentDir: string, name: string) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    createFolder?: (parentDir: string, name: string) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    copy?: (sources: string[], destDir: string) => Promise<{ ok: true; written: string[] } | { ok: false; reason: string }>
    move?: (sources: string[], destDir: string) => Promise<{ ok: true; written: string[] } | { ok: false; reason: string }>
    openInTerminal?: (p: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  }
  attachments: { listTree: () => Promise<FileNode[]> }
}

export type SelectMode = 'replace' | 'toggle' | 'range'
export type Clipboard = { mode: 'copy' | 'cut'; paths: string[] } | null
export type PendingNewNode = {
  parentPath: string
  source: FileSource
  kind: 'file' | 'dir'
} | null

type FileWatchEvent = {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
  path: string
  mtime?: number
}

type State = {
  fxOpen: boolean
  fxTreeWidth: number
  workspaceRoot: string | null
  workspaceTree: FileNode[]
  attachmentsTree: FileNode[]
  treeLoading: boolean
  tabs: FileTab[]
  activeTabId: string | null
  conflict: Conflict
  pendingChatInsert: string | null
  selectedPaths: string[]
  lastSelectedPath: string | null
  clipboard: Clipboard
  pendingNewNode: PendingNewNode
}

type Actions = {
  toggleFx: () => void
  setFxOpen: (open: boolean) => void
  setFxTreeWidth: (w: number) => void
  loadWorkspaceFolders: () => Promise<void>
  pickWorkspaceFolder: () => Promise<void>
  removeWorkspaceFolder: (path: string) => void
  refreshAttachmentsTree: () => Promise<void>
  expandDir: (path: string, source: FileSource) => Promise<void>
  openTab: (path: string, source: FileSource) => Promise<void>
  openAiChange: (change: FileChange) => Promise<void>
  openReference: (reference: AgentReference) => Promise<void>
  closeTab: (tabId: string, options?: { saveDirty?: boolean }) => Promise<boolean>
  setActiveTab: (tabId: string) => void
  saveTab: (tabId: string) => Promise<void>
  saveActiveTab: () => Promise<void>
  setActiveDoc: (doc: string) => void
  setTabState: (tabId: string, state: EditorState) => void
  applyExternalChange: (tabId: string, choice: 'mine' | 'disk') => Promise<void>
  requestApplyExternalContent: (filePath: string, content: string) => Promise<{ ok: boolean; reason?: string }>
  appendToChatInput: (text: string) => void
  consumePendingChatInsert: () => string | null
  trashFile: (path: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  renameFile: (oldPath: string, newName: string) => Promise<{ ok: true; newPath: string } | { ok: false; reason: string }>
  selectNode: (path: string, mode: SelectMode) => void
  clearSelection: () => void
  setSelectedPaths: (paths: string[]) => void
  selectAllVisible: (visiblePaths: string[]) => void
  copySelectionToClipboard: () => void
  cutSelectionToClipboard: () => void
  copyPathToOsClipboard: (paths: string[], relative: boolean) => Promise<void>
  pasteIntoDir: (destDir: string) => Promise<{ ok: boolean; reason?: string }>
  startNewNode: (parentPath: string, kind: 'file' | 'dir', source: FileSource) => Promise<void>
  commitNewNode: (name: string) => Promise<{ ok: boolean; reason?: string }>
  cancelNewNode: () => void
  openInTerminal: (path: string) => Promise<void>
  trashSelection: () => Promise<void>
  compareSelection: () => Promise<{ ok: boolean; reason?: string }>
  collectVisiblePaths: () => string[]
}

let unsubscribeWatch: (() => void) | null = null

function ensureWatchSubscription(getState: () => State & Actions): void {
  if (unsubscribeWatch || typeof window === 'undefined') return
  const api = (window as Window & { electronAPI?: ElectronFileApi }).electronAPI
  if (!api) return
  const fsApiWithEvents = api.fs as ElectronFileApi['fs'] & {
    onWatchEvent?: (cb: (event: FileWatchEvent) => void) => () => void
  }
  unsubscribeWatch = fsApiWithEvents.onWatchEvent?.(async (event) => {
    const tab = getState().tabs.find((t) => t.kind !== 'reference' && t.path === event.path)
    if (!tab) {
      await refreshWorkspaceRootsForEvent(event, getState)
      return
    }
    if (event.type === 'unlink') {
      useFileExplorerStore.setState((s) => ({
        tabs: s.tabs.filter((t) => t.id !== tab.id),
        activeTabId: s.activeTabId === tab.id ? (s.tabs.find((t) => t.id !== tab.id)?.id ?? null) : s.activeTabId,
        conflict: null,
      }))
      await refreshWorkspaceRootsForEvent(event, getState)
      return
    }
    if (event.type !== 'change') {
      await refreshWorkspaceRootsForEvent(event, getState)
      return
    }
    const r = await api.fs.readText(event.path)
    const currentTab = getState().tabs.find((t) => t.id === tab.id)
    if (!currentTab) return
    useFileExplorerStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === currentTab.id ? { ...t, diskContent: r.content, diskMtime: r.mtime, dirty: false, state: null } : t,
      ),
      conflict: null,
    }))
    await refreshWorkspaceRootsForEvent(event, getState)
  }) ?? null
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function readWorkspaceRoots(): string[] {
  const raw = readStorage(FX_WORKSPACE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
  } catch {
    // Older builds stored a single root string; keep that workspace when upgrading.
  }
  return raw.length > 0 ? [raw] : []
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // localStorage may be unavailable in tests or restricted environments.
  }
}

function persistWorkspaceRoots(roots: string[]): void {
  writeStorage(FX_WORKSPACE_KEY, JSON.stringify(roots))
}

function syncAllowedRoots(roots: string[]): void {
  try {
    void getApi().agent?.setAllowedRoots?.(roots)
  } catch {
    // Agent IPC may be unavailable in tests or non-Electron previews.
  }
}

async function syncAllowedRootsNow(roots: string[]): Promise<void> {
  try {
    await getApi().agent?.setAllowedRoots?.(roots)
  } catch {
    // Agent IPC may be unavailable in tests or non-Electron previews.
  }
}

function rootName(folder: string): string {
  return folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function aiChangeKey(change: FileChange): string {
  return `ai-change:${hashString(`${change.path}\0${change.diff}`)}`
}

function pathIsInsideRoot(path: string, root: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const p = normalize(path)
  const r = normalize(root)
  return p === r || p.startsWith(`${r}/`)
}

async function refreshWorkspaceRootsForEvent(
  event: FileWatchEvent,
  getState: () => State & Actions,
): Promise<void> {
  const state = getState()
  const touched = state.workspaceTree.filter((root) => pathIsInsideRoot(event.path, root.path))
  if (touched.length === 0) return
  const api = getApi()
  const refreshed = await Promise.all(
    state.workspaceTree.map(async (root) => {
      if (!touched.some((t) => t.path === root.path)) return root
      try {
        const children = await api.fs.listDir(root.path)
        return { ...root, childrenLoaded: true, children }
      } catch {
        return root
      }
    }),
  )
  useFileExplorerStore.setState({ workspaceTree: refreshed })
}

function getApi(): ElectronFileApi {
  const api = (window as Window & { electronAPI?: ElectronFileApi }).electronAPI
  if (!api) throw new Error('Electron file explorer API is unavailable')
  return api
}

function makeInitialState(): State {
  const rawWidth = Number(readStorage(FX_WIDTH_KEY) ?? 240)
  const workspaceRoots = readWorkspaceRoots()
  return {
    fxOpen: readStorage(FX_OPEN_KEY) === '1',
    fxTreeWidth: clampWidth(Number.isFinite(rawWidth) ? rawWidth : 240),
    workspaceRoot: workspaceRoots[0] ?? null,
    workspaceTree: [],
    attachmentsTree: [],
    treeLoading: false,
    tabs: [],
    activeTabId: null,
    conflict: null,
    pendingChatInsert: null,
    selectedPaths: [],
    lastSelectedPath: null,
    clipboard: null,
    pendingNewNode: null,
  }
}

let pendingDoc = ''

export const useFileExplorerStore = create<State & Actions>((set, get) => ({
  ...makeInitialState(),

  toggleFx: () => {
    set((s) => {
      const next = !s.fxOpen
      writeStorage(FX_OPEN_KEY, next ? '1' : '0')
      return { fxOpen: next }
    })
  },

  setFxOpen: (open) => {
    writeStorage(FX_OPEN_KEY, open ? '1' : '0')
    set({ fxOpen: open })
  },

  setFxTreeWidth: (w) => {
    const clamped = clampWidth(w)
    writeStorage(FX_WIDTH_KEY, String(clamped))
    set({ fxTreeWidth: clamped })
  },

  loadWorkspaceFolders: async () => {
    const api = getApi()
    const roots = readWorkspaceRoots()
    if (roots.length === 0) return
    const workspaceTree: FileNode[] = []
    for (const folder of roots) {
      try {
        const children = await api.fs.listDir(folder)
        await api.fs.watchStart(folder)
        workspaceTree.push({
          path: folder,
          name: rootName(folder),
          kind: 'dir',
          source: 'workspace',
          childrenLoaded: true,
          children,
        })
      } catch {
        // Ignore roots that are no longer available.
      }
    }
    if (workspaceTree.length > 0) {
      set({ workspaceRoot: workspaceTree[0]?.path ?? null, workspaceTree })
      syncAllowedRoots(workspaceTree.map((n) => n.path))
      ensureWatchSubscription(get)
    }
  },

  pickWorkspaceFolder: async () => {
    const api = getApi()
    const folder = await api.fs.pickFolder()
    if (!folder) return
    const roots = [...get().workspaceTree.filter((n) => n.path !== folder).map((n) => n.path), folder]
    await syncAllowedRootsNow(roots)
    const children = await api.fs.listDir(folder)
    await api.fs.watchStart(folder)
    set((s) => {
      const existing = s.workspaceTree.filter((n) => n.path !== folder)
      const workspaceTree: FileNode[] = [
        ...existing,
        {
          path: folder,
          name: rootName(folder),
          kind: 'dir',
          source: 'workspace',
          childrenLoaded: true,
          children,
        },
      ]
      persistWorkspaceRoots(workspaceTree.map((n) => n.path))
      syncAllowedRoots(workspaceTree.map((n) => n.path))
      return {
        workspaceRoot: workspaceTree[0]?.path ?? null,
        workspaceTree,
      }
    })
    ensureWatchSubscription(get)
  },

  removeWorkspaceFolder: (path) => {
    try {
      void getApi().fs.watchStop(path)
    } catch {
      // Tests and browser-like previews may not have the Electron API.
    }
    set((s) => {
      const workspaceTree = s.workspaceTree.filter((n) => n.path !== path)
      persistWorkspaceRoots(workspaceTree.map((n) => n.path))
      syncAllowedRoots(workspaceTree.map((n) => n.path))
      return {
        workspaceRoot: workspaceTree[0]?.path ?? null,
        workspaceTree,
      }
    })
  },

  refreshAttachmentsTree: async () => {
    const items = await getApi().attachments.listTree()
    set({
      attachmentsTree: [
        {
          path: '__attachments__',
          name: 'Attachments',
          kind: 'dir',
          source: 'attachments',
          childrenLoaded: true,
          children: items,
        },
      ],
    })
  },

  expandDir: async (p, source) => {
    if (source !== 'workspace') return
    const children = await getApi().fs.listDir(p)
    set((s) => ({ workspaceTree: replaceChildren(s.workspaceTree, p, children) }))
  },

  openTab: async (p, source) => {
    const existing = get().tabs.find((t) => t.path === p)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const api = getApi()
    const stat = await api.fs.stat(p)
    if (!stat.ok) return
    const kind = classify(p.split(/[\\/]/).pop() ?? p, stat.size, stat.mime)
    let content = ''
    if (kind === 'text') {
      const r = await api.fs.readText(p)
      content = r.content
      await api.fs.watchStart(p)
    }
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const tab: FileTab = {
      id,
      path: p,
      name: p.split(/[\\/]/).pop() ?? p,
      source,
      kind,
      state: null,
      diskContent: content,
      diskMtime: stat.mtime,
      dirty: false,
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
    ensureWatchSubscription(get)
  },

  openAiChange: async (change) => {
    const key = aiChangeKey(change)
    const existing = get().tabs.find((t) => t.kind === 'ai-change' && t.aiChangeKey === key)
    if (existing) {
      set({ activeTabId: existing.id, fxOpen: true })
      writeStorage(FX_OPEN_KEY, '1')
      return
    }

    const parsed = parseUnifiedDiff(change.diff)
    const id = globalThis.crypto?.randomUUID?.() ?? `ai-change-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const tab: FileTab = {
      id,
      path: '',
      name: basename(change.path),
      source: 'workspace',
      kind: 'ai-change',
      state: null,
      diskContent: '',
      diskMtime: 0,
      dirty: false,
      aiChangeKey: key,
      aiChange: {
        change,
        ...(parsed.ok
          ? { beforeContent: parsed.beforeContent, afterContent: parsed.afterContent }
          : { parseError: parsed.reason }),
      },
    }

    set((s) => ({
      fxOpen: true,
      activeTabId: id,
      tabs: [...s.tabs, tab],
    }))
    writeStorage(FX_OPEN_KEY, '1')
  },

  openReference: async (reference) => {
    if (
      reference.source.kind === 'localPath' &&
      (reference.openBehavior === 'code' ||
        reference.openBehavior === 'markdown' ||
        reference.openBehavior === 'image' ||
        reference.openBehavior === 'pdf')
    ) {
      const localPath = reference.source.path
      try {
        await get().openTab(localPath, 'workspace')
        const openedTab = get().tabs.find(
          (tab) => tab.kind !== 'reference' && tab.path === localPath,
        )
        if (openedTab && get().activeTabId === openedTab.id) {
          set({ fxOpen: true })
          writeStorage(FX_OPEN_KEY, '1')
          return
        }
      } catch {
        // Fall through to the reference tab so the panel still shows useful details.
      }
    }

    const existing = get().tabs.find((t) => t.referenceKey === reference.id)
    if (existing) {
      set({ activeTabId: existing.id, fxOpen: true })
      writeStorage(FX_OPEN_KEY, '1')
      return
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `ref-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const tab: FileTab = {
      id,
      path: '',
      name: reference.label,
      source: 'workspace',
      kind: 'reference',
      state: null,
      diskContent: '',
      diskMtime: 0,
      dirty: false,
      referenceKey: reference.id,
      reference,
    }

    set((s) => ({
      fxOpen: true,
      activeTabId: id,
      tabs: [...s.tabs, tab],
    }))
    writeStorage(FX_OPEN_KEY, '1')
  },

  closeTab: async (tabId, options) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return false
    if (tab.dirty && tab.kind === 'text') {
      if (options?.saveDirty === true) {
        await get().saveTab(tabId)
      } else if (options?.saveDirty !== false) {
        return false
      }
    }
    if (tab.kind === 'text') {
      try {
        void getApi().fs.watchStop(tab.path)
      } catch {
        // Renderer tests and browser-like previews may not have the Electron API.
      }
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId = s.activeTabId === tabId ? (tabs[0]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    })
    return true
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  setActiveDoc: (doc) => {
    pendingDoc = doc
  },

  setTabState: (tabId, state) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, state, dirty: state.doc.toString() !== t.diskContent } : t,
      ),
    }))
  },

  saveTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'text') return
    const content = tab.state?.doc.toString() ?? pendingDoc
    const r = await getApi().fs.writeText(tab.path, content)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, dirty: false, diskContent: content, diskMtime: r.mtime } : t,
      ),
    }))
  },

  saveActiveTab: async () => {
    const { activeTabId } = get()
    if (!activeTabId) return
    await get().saveTab(activeTabId)
  },

  applyExternalChange: async (tabId, choice) => {
    const conflict = get().conflict
    if (!conflict || conflict.tabId !== tabId) return
    if (choice === 'disk') {
      // For `source: 'apply'` we additionally need to PERSIST the AI content
      // to disk — applyExternalChange's original semantics only mutated the
      // in-memory tab. Without writing, "Apply" appears to work but a reload
      // would discard the AI version.
      if (conflict.source === 'apply') {
        const tab = get().tabs.find((t) => t.id === tabId)
        if (tab) {
          const api = getApi()
          if (api.fs.writeText) {
            const res = await api.fs.writeText(tab.path, conflict.diskContent)
            if (!res.ok) {
              // Preserve conflict so the user can retry
              return
            }
          }
        }
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, diskContent: conflict.diskContent, dirty: false, state: null } : t,
        ),
        conflict: null,
      }))
      return
    }
    set({ conflict: null })
  },

  /**
   * Apply an AI-suggested file content (e.g. a fenced code block in chat) by
   * surfacing the existing ConflictModal flow with `source: 'apply'`.
   *
   * Behavior:
   * 1. Open the file as a tab if not already (read-only path through openTab).
   * 2. Set `conflict = { tabId, diskContent: AI content, source: 'apply' }`.
   * 3. ConflictModal swaps button labels to Cancel / Apply / Show diff and
   *    `applyExternalChange(tabId, 'disk')` writes the AI content to disk.
   *
   * Returns `{ ok: false }` only if we couldn't open the file (e.g. unknown
   * source/path); the user-facing decision still happens in the modal.
   */
  requestApplyExternalContent: async (filePath, content) => {
    if (!filePath) return { ok: false, reason: 'missing path' }
    // Try to find an existing tab; otherwise open one
    let tab = get().tabs.find((t) => t.path === filePath)
    if (!tab) {
      const sourceGuess = inferSource(get().workspaceTree, filePath)
      await get().openTab(filePath, sourceGuess)
      tab = get().tabs.find((t) => t.path === filePath)
      if (!tab) return { ok: false, reason: 'tab not found after open' }
    }
    set({
      activeTabId: tab.id,
      conflict: {
        tabId: tab.id,
        diskContent: content,
        show: 'modal',
        source: 'apply',
      },
    })
    return { ok: true }
  },

  appendToChatInput: (text) => set({ pendingChatInsert: text }),

  consumePendingChatInsert: () => {
    const v = get().pendingChatInsert
    set({ pendingChatInsert: null })
    return v
  },

  trashFile: async (p) => {
    const api = getApi()
    if (!api.fs.trash) return { ok: false, reason: 'trash API not available' }
    const res = await api.fs.trash(p)
    if (!res.ok) return res
    set((s) => ({
      workspaceTree: removeFromTree(s.workspaceTree, p),
      attachmentsTree: removeFromTree(s.attachmentsTree, p),
      tabs: s.tabs.filter((t) => t.path !== p),
      activeTabId: s.tabs.find((t) => t.path === p)?.id === s.activeTabId
        ? s.tabs.find((t) => t.path !== p)?.id ?? null
        : s.activeTabId,
    }))
    return { ok: true }
  },

  renameFile: async (oldPath, newName) => {
    const api = getApi()
    if (!api.fs.rename) return { ok: false, reason: 'rename API not available' }
    const res = await api.fs.rename(oldPath, newName)
    if (!res.ok) return res
    set((s) => ({
      workspaceTree: renameInTree(s.workspaceTree, oldPath, res.newPath, newName),
      attachmentsTree: renameInTree(s.attachmentsTree, oldPath, res.newPath, newName),
      tabs: s.tabs.map((t) =>
        t.path === oldPath ? { ...t, path: res.newPath, name: newName } : t,
      ),
    }))
    return res
  },

  selectNode: (path, mode) => {
    set((s) => {
      if (mode === 'replace') {
        return { selectedPaths: [path], lastSelectedPath: path }
      }
      if (mode === 'toggle') {
        const exists = s.selectedPaths.includes(path)
        const next = exists ? s.selectedPaths.filter((p) => p !== path) : [...s.selectedPaths, path]
        return { selectedPaths: next, lastSelectedPath: path }
      }
      // range: select from lastSelectedPath to path within visible flat order
      const visible = collectVisibleFlat(s.workspaceTree).concat(collectVisibleFlat(s.attachmentsTree))
      const anchor = s.lastSelectedPath ?? path
      const a = visible.indexOf(anchor)
      const b = visible.indexOf(path)
      if (a < 0 || b < 0) return { selectedPaths: [path], lastSelectedPath: path }
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const range = visible.slice(lo, hi + 1)
      return { selectedPaths: range, lastSelectedPath: path }
    })
  },

  clearSelection: () => set({ selectedPaths: [], lastSelectedPath: null }),

  setSelectedPaths: (paths) => set({ selectedPaths: paths, lastSelectedPath: paths[paths.length - 1] ?? null }),

  selectAllVisible: (visiblePaths) => set({ selectedPaths: visiblePaths, lastSelectedPath: visiblePaths[visiblePaths.length - 1] ?? null }),

  collectVisiblePaths: () => {
    const s = get()
    return collectVisibleFlat(s.workspaceTree).concat(collectVisibleFlat(s.attachmentsTree))
  },

  copySelectionToClipboard: () => {
    const s = get()
    if (s.selectedPaths.length === 0) return
    set({ clipboard: { mode: 'copy', paths: [...s.selectedPaths] } })
    void writeToOsClipboard(s.selectedPaths)
  },

  cutSelectionToClipboard: () => {
    const s = get()
    if (s.selectedPaths.length === 0) return
    set({ clipboard: { mode: 'cut', paths: [...s.selectedPaths] } })
    void writeToOsClipboard(s.selectedPaths)
  },

  copyPathToOsClipboard: async (paths, relative) => {
    if (paths.length === 0) return
    const root = get().workspaceRoot ?? ''
    const text = paths
      .map((p) => (relative && root ? toRelative(root, p) : p))
      .join('\n')
    await writeTextToOsClipboard(text)
  },

  pasteIntoDir: async (destDir) => {
    const api = getApi()
    const cb = get().clipboard
    if (!cb || cb.paths.length === 0) return { ok: false, reason: 'clipboard empty' }
    if (cb.mode === 'copy') {
      if (!api.fs.copy) return { ok: false, reason: 'copy API not available' }
      const res = await api.fs.copy(cb.paths, destDir)
      if (!res.ok) return res
    } else {
      if (!api.fs.move) return { ok: false, reason: 'move API not available' }
      const res = await api.fs.move(cb.paths, destDir)
      if (!res.ok) return res
      // 剪切后清空剪贴板
      set({ clipboard: null })
    }
    // 刷新目标目录
    const source = inferSource(get().workspaceTree, destDir)
    await get().expandDir(destDir, source)
    return { ok: true }
  },

  startNewNode: async (parentPath, kind, source) => {
    // 确保父目录在树中是展开的
    const parentNode = findNodeInTrees(get().workspaceTree, get().attachmentsTree, parentPath)
    if (parentNode && parentNode.kind === 'dir' && !parentNode.childrenLoaded) {
      await get().expandDir(parentPath, source)
    }
    set({ pendingNewNode: { parentPath, kind, source } })
  },

  commitNewNode: async (name) => {
    const api = getApi()
    const pending = get().pendingNewNode
    if (!pending) return { ok: false, reason: 'no pending new node' }
    if (!name.trim()) {
      set({ pendingNewNode: null })
      return { ok: false, reason: 'empty name' }
    }
    const fn = pending.kind === 'file' ? api.fs.createFile : api.fs.createFolder
    if (!fn) {
      set({ pendingNewNode: null })
      return { ok: false, reason: 'create API not available' }
    }
    const res = await fn(pending.parentPath, name.trim())
    set({ pendingNewNode: null })
    if (!res.ok) return res
    await get().expandDir(pending.parentPath, pending.source)
    set({ selectedPaths: [res.path], lastSelectedPath: res.path })
    return { ok: true }
  },

  cancelNewNode: () => set({ pendingNewNode: null }),

  openInTerminal: async (p) => {
    const api = getApi()
    if (!api.fs.openInTerminal) return
    await api.fs.openInTerminal(p)
  },

  trashSelection: async () => {
    const paths = [...get().selectedPaths]
    if (paths.length === 0) return
    const api = getApi()
    if (!api.fs.trash) return
    for (const p of paths) {
      const res = await api.fs.trash(p)
      if (!res.ok) continue
      set((s) => ({
        workspaceTree: removeFromTree(s.workspaceTree, p),
        attachmentsTree: removeFromTree(s.attachmentsTree, p),
        tabs: s.tabs.filter((t) => t.path !== p),
      }))
    }
    set({ selectedPaths: [], lastSelectedPath: null })
  },

  compareSelection: async () => {
    const paths = [...get().selectedPaths]
    if (paths.length !== 2) {
      return { ok: false, reason: '请选择两个文件后再比较' }
    }
    const [leftPath, rightPath] = paths
    const api = getApi()
    if (!api.fs.readText) {
      return { ok: false, reason: '不支持读取文本' }
    }
    const [leftRes, rightRes] = await Promise.all([
      api.fs.readText(leftPath),
      api.fs.readText(rightPath),
    ])
    if (!leftRes.ok) return { ok: false, reason: `读取左侧失败: ${leftRes.reason}` }
    if (!rightRes.ok) return { ok: false, reason: `读取右侧失败: ${rightRes.reason}` }

    const leftName = leftPath.split(/[\\/]/).pop() ?? leftPath
    const rightName = rightPath.split(/[\\/]/).pop() ?? rightPath
    const id = `compare:${leftPath}::${rightPath}`
    const tab: FileTab = {
      id,
      path: '',
      name: `${leftName} ↔ ${rightName}`,
      source: 'workspace',
      kind: 'compare',
      state: null,
      diskContent: '',
      diskMtime: 0,
      dirty: false,
      compare: {
        left: leftPath,
        right: rightPath,
        leftContent: leftRes.text,
        rightContent: rightRes.text,
      },
    }
    set((s) => {
      const existing = s.tabs.findIndex((t) => t.id === id)
      const tabs = existing >= 0
        ? s.tabs.map((t, i) => (i === existing ? tab : t))
        : [...s.tabs, tab]
      return { tabs, activeTabId: id }
    })
    return { ok: true }
  },
}))

// 辅助：将一个工作区根的绝对路径转成相对路径
function toRelative(root: string, p: string): string {
  if (!p.startsWith(root)) return p
  const rel = p.slice(root.length).replace(/^[\\/]+/, '')
  return rel || '.'
}

// 辅助：扁平化收集所有当前展开的可见节点路径（按 DFS 顺序）
function collectVisibleFlat(tree: FileNode[]): string[] {
  const out: string[] = []
  const walk = (nodes: FileNode[]): void => {
    for (const n of nodes) {
      out.push(n.path)
      if (n.kind === 'dir' && n.childrenLoaded && n.children) walk(n.children)
    }
  }
  walk(tree)
  return out
}

function findNodeInTrees(a: FileNode[], b: FileNode[], target: string): FileNode | null {
  return findNode(a, target) ?? findNode(b, target)
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

function inferSource(workspace: FileNode[], path: string): FileSource {
  const inWs = !!findNode(workspace, path)
  return inWs ? 'workspace' : 'attachments'
}

async function writeToOsClipboard(paths: string[]): Promise<void> {
  await writeTextToOsClipboard(paths.join('\n'))
}

async function writeTextToOsClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 静默失败：内部状态仍然有效
    }
  }
}

function replaceChildren(tree: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
  return tree.map((n) => {
    if (n.path === targetPath) return { ...n, childrenLoaded: true, children }
    if (n.children) return { ...n, children: replaceChildren(n.children, targetPath, children) }
    return n
  })
}

function removeFromTree(tree: FileNode[], targetPath: string): FileNode[] {
  return tree
    .filter((n) => n.path !== targetPath)
    .map((n) =>
      n.children ? { ...n, children: removeFromTree(n.children, targetPath) } : n,
    )
}

function renameInTree(tree: FileNode[], oldPath: string, newPath: string, newName: string): FileNode[] {
  return tree.map((n) => {
    if (n.path === oldPath) return { ...n, path: newPath, name: newName }
    if (n.children) return { ...n, children: renameInTree(n.children, oldPath, newPath, newName) }
    return n
  })
}
