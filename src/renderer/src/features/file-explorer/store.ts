import { create } from 'zustand'
import type { EditorState } from '@codemirror/state'
import type { AgentReference } from '../../../../types/agent-reference'
import type { Conflict, FileNode, FileSource, FileTab } from './types'
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
  }
  attachments: { listTree: () => Promise<FileNode[]> }
}

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
  openReference: (reference: AgentReference) => Promise<void>
  closeTab: (tabId: string, options?: { saveDirty?: boolean }) => Promise<boolean>
  setActiveTab: (tabId: string) => void
  saveTab: (tabId: string) => Promise<void>
  saveActiveTab: () => Promise<void>
  setActiveDoc: (doc: string) => void
  setTabState: (tabId: string, state: EditorState) => void
  applyExternalChange: (tabId: string, choice: 'mine' | 'disk') => Promise<void>
  appendToChatInput: (text: string) => void
  consumePendingChatInsert: () => string | null
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
      useFileExplorerStore.setState({
        conflict: { tabId: tab.id, diskContent: '', show: 'modal' },
      })
      await refreshWorkspaceRootsForEvent(event, getState)
      return
    }
    if (event.type !== 'change') {
      await refreshWorkspaceRootsForEvent(event, getState)
      return
    }
    const r = await api.fs.readText(event.path)
    if (!tab.dirty) {
      useFileExplorerStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id ? { ...t, diskContent: r.content, diskMtime: r.mtime, state: null } : t,
        ),
      }))
    } else {
      useFileExplorerStore.setState({
        conflict: { tabId: tab.id, diskContent: r.content, show: 'modal' },
      })
    }
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

  openReference: async (reference) => {
    if (
      reference.source.kind === 'localPath' &&
      (reference.openBehavior === 'code' ||
        reference.openBehavior === 'markdown' ||
        reference.openBehavior === 'image' ||
        reference.openBehavior === 'pdf')
    ) {
      set({ fxOpen: true })
      writeStorage(FX_OPEN_KEY, '1')
      await get().openTab(reference.source.path, 'workspace')
      return
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

  appendToChatInput: (text) => set({ pendingChatInsert: text }),

  consumePendingChatInsert: () => {
    const v = get().pendingChatInsert
    set({ pendingChatInsert: null })
    return v
  },
}))

function replaceChildren(tree: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
  return tree.map((n) => {
    if (n.path === targetPath) return { ...n, childrenLoaded: true, children }
    if (n.children) return { ...n, children: replaceChildren(n.children, targetPath, children) }
    return n
  })
}
