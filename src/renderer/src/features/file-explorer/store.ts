import { create } from 'zustand'
import type { EditorState } from '@codemirror/state'
import type { Conflict, FileNode, FileSource, FileTab } from './types'
import { classify } from './classify'

const FX_WIDTH_KEY = 'agent-chat:fx-tree-width'
const FX_WORKSPACE_KEY = 'agent-chat:fx-workspace-root'
const FX_OPEN_KEY = 'agent-chat:fx-open'

const clampWidth = (w: number): number => Math.max(200, Math.min(360, w))

type ElectronFileApi = {
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
  pickWorkspaceFolder: () => Promise<void>
  refreshAttachmentsTree: () => Promise<void>
  expandDir: (path: string, source: FileSource) => Promise<void>
  openTab: (path: string, source: FileSource) => Promise<void>
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  saveActiveTab: () => Promise<void>
  setActiveDoc: (doc: string) => void
  setTabState: (tabId: string, state: EditorState) => void
  applyExternalChange: (tabId: string, choice: 'mine' | 'disk') => Promise<void>
  appendToChatInput: (text: string) => void
  consumePendingChatInsert: () => string | null
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // localStorage may be unavailable in tests or restricted environments.
  }
}

function getApi(): ElectronFileApi {
  const api = (window as Window & { electronAPI?: ElectronFileApi }).electronAPI
  if (!api) throw new Error('Electron file explorer API is unavailable')
  return api
}

function makeInitialState(): State {
  const rawWidth = Number(readStorage(FX_WIDTH_KEY) ?? 240)
  return {
    fxOpen: readStorage(FX_OPEN_KEY) === '1',
    fxTreeWidth: clampWidth(Number.isFinite(rawWidth) ? rawWidth : 240),
    workspaceRoot: readStorage(FX_WORKSPACE_KEY),
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

  pickWorkspaceFolder: async () => {
    const api = getApi()
    const folder = await api.fs.pickFolder()
    if (!folder) return
    writeStorage(FX_WORKSPACE_KEY, folder)
    const children = await api.fs.listDir(folder)
    set({
      workspaceRoot: folder,
      workspaceTree: [
        {
          path: folder,
          name: folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder,
          kind: 'dir',
          source: 'workspace',
          childrenLoaded: true,
          children,
        },
      ],
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
  },

  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    if (tab.kind === 'text') void getApi().fs.watchStop(tab.path)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId = s.activeTabId === tabId ? (tabs[0]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    })
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

  saveActiveTab: async () => {
    const { activeTabId, tabs } = get()
    if (!activeTabId) return
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab || tab.kind !== 'text') return
    const content = tab.state?.doc.toString() ?? pendingDoc
    const r = await getApi().fs.writeText(tab.path, content)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId ? { ...t, dirty: false, diskContent: content, diskMtime: r.mtime } : t,
      ),
    }))
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
