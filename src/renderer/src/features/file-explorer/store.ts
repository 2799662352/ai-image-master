import { create } from 'zustand'
import type { EditorState } from '@codemirror/state'
import type { AgentReference } from '../../../../types/agent-reference'
import type { FileChange } from '../../../../types/agent-timeline'
import type { Conflict, FileNode, FileSource, FileTab } from './types'
import { removeFromTree, renameInTree, updateNodeInTree } from './treeOps'
import { parseUnifiedDiff } from '../agent-chat/diff/parseUnifiedDiff'
import { classify } from './classify'

const FX_WIDTH_KEY = 'agent-chat:fx-tree-width'
const FX_WORKSPACE_KEY = 'agent-chat:fx-workspace-root'
const FX_OPEN_KEY = 'agent-chat:fx-open'
const FX_COLLAPSED_KEY = 'agent-chat:fx-collapsed'
const FX_VIEWER_COLLAPSED_KEY = 'agent-chat:fx-viewer-collapsed'

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
    importExternal?: (sources: string[], destDir: string) => Promise<
      { ok: true; written: string[] } | { ok: false; reason: string; written?: string[] }
    >
    openInTerminal?: (p: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  }
  attachments: {
    listTree: () => Promise<FileNode[]>
    onChanged?: (cb: () => void) => () => void
  }
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
  /**
   * 「收起但保持挂载」:面板用 CSS 滑出屏幕左侧,左缘留一个把手。与
   * fxOpen=false(整个卸载)不同 —— tldraw 画布是 agent canvas_* 工具的
   * 运行时(见 ViewerHost keep-alive 注释),收起绝不能触发卸载。
   */
  fxCollapsed: boolean
  /**
   * 「只收中间查看器」:保留左侧文件树,仅隐藏中间查看器列(invisible 保
   * 尺寸,tldraw keep-alive 不受影响),露出底下的经典生图/生视频界面。
   * 与 fxCollapsed(整栏收起)互不冲突,整栏收起优先。
   */
  fxViewerCollapsed: boolean
  fxTreeWidth: number
  workspaceRoot: string | null
  workspaceTree: FileNode[]
  attachmentsTree: FileNode[]
  treeLoading: boolean
  tabs: FileTab[]
  activeTabId: string | null
  /**
   * Monotonic counter the tab strip watches to scroll the active tab into
   * view. Bumped on every `openTab` / `openReference` / explicit user
   * "jump back" click on `LatestPreviewBanner`. We use a counter rather
   * than just observing `activeTabId` so the "jump back" gesture still
   * fires even when the active tab id hasn't changed (e.g. the user
   * scrolled the strip horizontally and the active tab is out of view).
   */
  scrollActiveTabToken: number
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
  toggleFxCollapsed: () => void
  toggleFxViewerCollapsed: () => void
  setFxTreeWidth: (w: number) => void
  /**
   * 把已展开的目录全部重列一遍。文件树的兜底 —— 见 refreshLoadedDirs 的说明。
   * 手动刷新按钮、窗口重获焦点、面板从隐藏变可见,都走这一个入口。
   */
  refreshTree: () => Promise<void>
  loadWorkspaceFolders: () => Promise<void>
  pickWorkspaceFolder: () => Promise<void>
  removeWorkspaceFolder: (path: string) => void
  refreshAttachmentsTree: () => Promise<void>
  expandDir: (path: string, source: FileSource) => Promise<void>
  openTab: (path: string, source: FileSource) => Promise<void>
  /**
   * Open (or re-activate) the singleton tldraw Canvas tab in the center
   * display. The canvas is a renderer-only surface (no disk file), so it
   * carries an empty path and a stable id like reference/ai-change tabs.
   */
  openCanvasTab: () => void
  openAiChange: (change: FileChange) => Promise<void>
  openReference: (reference: AgentReference) => Promise<void>
  closeTab: (tabId: string, options?: { saveDirty?: boolean }) => Promise<boolean>
  setActiveTab: (tabId: string) => void
  /** Bump the scroll token to re-trigger "scrollIntoView" on FileTabStrip. */
  requestScrollActiveTabIntoView: () => void
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
  /**
   * Open the panel, expand to + select an absolute path, and broadcast a
   * `file-explorer:reveal` event so the matching tree row scrolls into view.
   * Used by chat-link clicks ("show this generated image in FILES").
   */
  revealPath: (absPath: string) => Promise<void>
  clearSelection: () => void
  setSelectedPaths: (paths: string[]) => void
  selectAllVisible: (visiblePaths: string[]) => void
  copySelectionToClipboard: () => void
  cutSelectionToClipboard: () => void
  copyPathToOsClipboard: (paths: string[], relative: boolean) => Promise<void>
  pasteIntoDir: (destDir: string) => Promise<{ ok: boolean; reason?: string }>
  /**
   * Drag-and-drop move. Pre-checks dir-into-self/descendant and same-dir
   * no-op in the renderer so the UI never round-trips to main for an
   * obviously-invalid drop. Delegates the real move to `fs.move`, which is
   * the same IPC `pasteIntoDir` uses for cut+paste (handles EXDEV, ID
   * conflicts, and dir-into-self on the server side as defense-in-depth).
   */
  moveByDnd: (sources: string[], destDir: string) => Promise<{ ok: boolean; reason?: string }>
  importExternalByDnd: (sources: string[], destDir: string) => Promise<{ ok: boolean; reason?: string; written?: string[] }>
  startNewNode: (parentPath: string, kind: 'file' | 'dir', source: FileSource) => Promise<void>
  commitNewNode: (name: string) => Promise<{ ok: boolean; reason?: string }>
  cancelNewNode: () => void
  openInTerminal: (path: string) => Promise<void>
  trashSelection: () => Promise<void>
  compareSelection: () => Promise<{ ok: boolean; reason?: string }>
  collectVisiblePaths: () => string[]
  /**
   * Idempotent. Sets up renderer-side IPC subscriptions:
   *  - `fs.onWatchEvent` for workspace file changes (chokidar push)
   *  - `attachments.onChanged` for chat-uploaded attachments (AttachmentService push)
   *
   * Safe to call from any mount effect; later calls are no-ops. Tests can
   * call this directly to wire the subscription without going through a full
   * workspace flow.
   */
  ensureSubscriptions: () => void
}

let unsubscribeWatch: (() => void) | null = null
let unsubscribeAttachments: (() => void) | null = null
let attachmentsRefreshTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeFocus: (() => void) | null = null

const ATTACHMENTS_REFRESH_DEBOUNCE_MS = 200

function ensureFsWatchSubscription(getState: () => State & Actions): void {
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

function ensureAttachmentsSubscription(getState: () => State & Actions): void {
  if (unsubscribeAttachments || typeof window === 'undefined') return
  const api = (window as Window & { electronAPI?: ElectronFileApi }).electronAPI
  if (!api?.attachments?.onChanged) return
  unsubscribeAttachments = api.attachments.onChanged(() => {
    // Trailing-edge debounce: AttachmentService.ingest() runs sequentially and
    // emits per-file, so a burst of N uploads would otherwise trigger N
    // back-to-back readdir + Prisma round-trips. 200ms aggregates the burst
    // into a single refresh without making the UI feel laggy.
    if (attachmentsRefreshTimer) clearTimeout(attachmentsRefreshTimer)
    attachmentsRefreshTimer = setTimeout(() => {
      attachmentsRefreshTimer = null
      void getState().refreshAttachmentsTree()
    }, ATTACHMENTS_REFRESH_DEBOUNCE_MS)
  })
}

/**
 * 把所有**已展开**的目录重列一遍,合并进树里。
 *
 * 这是文件树的兜底:面板本来完全依赖 chokidar 推事件来刷新,而那条链上任何一环
 * 出问题(事件没发出、路径不在监视范围、目录还没展开过),面板就会**静默地**停在
 * 旧状态 —— 用户看到「AI 把文件移进文件夹了,面板里什么都没变」,而且没有任何
 * 办法让它自己好。
 *
 * VS Code 也是这么兜的:切回窗口时重新扫描,因为它同样不能假设外部改动都被监视到。
 *
 * 只重列已展开的目录 —— 没展开的看不见内容,重列纯属浪费(几百个文件夹就是几百次
 * IPC)。展开状态由 mergeListedChildren 保住。
 */
async function refreshLoadedDirs(getState: () => State & Actions): Promise<void> {
  const collect = (nodes: FileNode[], out: string[]): void => {
    for (const n of nodes) {
      if (n.kind !== 'dir' || !n.childrenLoaded) continue
      out.push(n.path)
      if (n.children) collect(n.children, out)
    }
  }
  const paths: string[] = []
  collect(getState().workspaceTree, paths)
  if (paths.length === 0) return

  const api = (window as Window & { electronAPI?: ElectronFileApi }).electronAPI
  if (!api?.fs?.listDir) return

  // 由浅入深逐个应用:先刷父目录,再刷子目录,这样子目录的合并结果不会被随后
  // 父目录的重列覆盖掉。
  for (const p of paths) {
    let listed: FileNode[]
    try {
      listed = await api.fs.listDir(p)
    } catch {
      continue // 目录可能刚被删掉 —— 跳过,别让一个坏路径中断整轮刷新。
    }
    useFileExplorerStore.setState((s) => ({
      workspaceTree: updateNodeInTree(s.workspaceTree, p, (n) => ({
        ...n,
        childrenLoaded: true,
        children: mergeListedChildren(n.children, listed),
      })),
    }))
  }
}

export function ensureWatchSubscription(getState: () => State & Actions): void {
  ensureFsWatchSubscription(getState)
  ensureAttachmentsSubscription(getState)
  ensureFocusRefresh(getState)
}

/** 窗口重获焦点 = 用户回来看了 —— 这一刻树必须是真的。 */
function ensureFocusRefresh(getState: () => State & Actions): void {
  if (unsubscribeFocus || typeof window === 'undefined') return
  let running = false
  const onFocus = (): void => {
    if (running) return
    running = true
    void refreshLoadedDirs(getState).finally(() => {
      running = false
    })
  }
  window.addEventListener('focus', onFocus)
  unsubscribeFocus = () => window.removeEventListener('focus', onFocus)
}

/**
 * Test-only: reset module-level subscription singletons so Vitest's per-test
 * `setState(initialState, true)` actually starts from a clean slate. Production
 * code should NOT call this — leaking a subscription across windows would
 * cause double-fire.
 */
export function __resetSubscriptionsForTesting(): void {
  unsubscribeWatch?.()
  unsubscribeWatch = null
  unsubscribeAttachments?.()
  unsubscribeAttachments = null
  unsubscribeFocus?.()
  unsubscribeFocus = null
  if (attachmentsRefreshTimer) {
    clearTimeout(attachmentsRefreshTimer)
    attachmentsRefreshTimer = null
  }
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

/**
 * Find the deepest already-expanded directory in `tree` that contains
 * `targetPath` (or matches it). The watcher fires events for any descendant,
 * so we only need to re-list the closest expanded ancestor — re-listing the
 * workspace root would drop the children of every other expanded subdir,
 * which is exactly what caused the "folder collapses on save" + "new file
 * doesn't appear" regression.
 */
function findDeepestAncestorDir(tree: FileNode[], targetPath: string): FileNode | null {
  let best: FileNode | null = null
  const visit = (n: FileNode): void => {
    if (n.kind !== 'dir' || !n.childrenLoaded) return
    if (n.path === targetPath || pathIsInsideRoot(targetPath, n.path)) {
      if (!best || n.path.length > best.path.length) best = n
      if (n.children) for (const c of n.children) visit(c)
    }
  }
  for (const t of tree) visit(t)
  return best
}

/**
 * Splice already-loaded subtrees from `prevChildren` onto matching nodes in
 * `listed`. Without this step, every re-list would replace `{childrenLoaded:
 * true, children: [...]}` with `{childrenLoaded: false}` on every expanded
 * subdir, visually collapsing them. Matches by `path`; non-dir entries and
 * paths only in `listed` pass through unchanged.
 */
function mergeListedChildren(prevChildren: FileNode[] | undefined, listed: FileNode[]): FileNode[] {
  if (!prevChildren || prevChildren.length === 0) return listed
  const prevByPath = new Map<string, FileNode>()
  for (const p of prevChildren) prevByPath.set(p.path, p)
  return listed.map((next) => {
    if (next.kind !== 'dir') return next
    const prev = prevByPath.get(next.path)
    if (prev && prev.kind === 'dir' && prev.childrenLoaded) {
      return { ...next, childrenLoaded: true, children: prev.children ?? [] }
    }
    return next
  })
}

async function refreshWorkspaceRootsForEvent(
  event: FileWatchEvent,
  getState: () => State & Actions,
): Promise<void> {
  const state = getState()
  const target = findDeepestAncestorDir(state.workspaceTree, event.path)
  if (!target) return
  let listed: FileNode[]
  try {
    listed = await getApi().fs.listDir(target.path)
  } catch {
    return
  }
  // Re-read latest state in case the user toggled expansion mid-IPC; we'll
  // still apply the merge — the targeted dir is the only one we mutate.
  useFileExplorerStore.setState((s) => ({
    workspaceTree: updateNodeInTree(s.workspaceTree, target.path, (n) => ({
      ...n,
      childrenLoaded: true,
      children: mergeListedChildren(n.children, listed),
    })),
  }))
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
    fxCollapsed: readStorage(FX_COLLAPSED_KEY) === '1',
    fxViewerCollapsed: readStorage(FX_VIEWER_COLLAPSED_KEY) === '1',
    fxTreeWidth: clampWidth(Number.isFinite(rawWidth) ? rawWidth : 240),
    workspaceRoot: workspaceRoots[0] ?? null,
    workspaceTree: [],
    attachmentsTree: [],
    treeLoading: false,
    tabs: [],
    activeTabId: null,
    scrollActiveTabToken: 0,
    conflict: null,
    pendingChatInsert: null,
    selectedPaths: [],
    lastSelectedPath: null,
    clipboard: null,
    pendingNewNode: null,
  }
}

/**
 * 「自动打开面板」的路径(openCanvasTab / openAiChange / openReference 等)
 * 统一走这里:置 fxOpen 并解除 fxCollapsed(否则 agent 打开文件时面板还
 * 收在左边,用户什么都看不见),两个标记同时持久化。
 */
function fxPanelVisibleState(): { fxOpen: true; fxCollapsed: false; fxViewerCollapsed: false } {
  writeStorage(FX_OPEN_KEY, '1')
  writeStorage(FX_COLLAPSED_KEY, '0')
  writeStorage(FX_VIEWER_COLLAPSED_KEY, '0')
  return { fxOpen: true, fxCollapsed: false, fxViewerCollapsed: false }
}

let pendingDoc = ''

export const useFileExplorerStore = create<State & Actions>((set, get) => ({
  ...makeInitialState(),

  refreshTree: () => refreshLoadedDirs(get),

  toggleFx: () => {
    set((s) => {
      const next = !s.fxOpen
      writeStorage(FX_OPEN_KEY, next ? '1' : '0')
      // 面板从隐藏变可见 = 用户要看了,这一刻树必须是真的。VS Code 同款
      // (microsoft/vscode#126817:「refresh both when the window gets focus,
      // and when the explorer becomes visible」)。
      if (next) void refreshLoadedDirs(get)
      // 打开永远展示完整面板:否则「收着的面板被打开」= 用户看到一片空。
      if (next && (s.fxCollapsed || s.fxViewerCollapsed)) {
        writeStorage(FX_COLLAPSED_KEY, '0')
        writeStorage(FX_VIEWER_COLLAPSED_KEY, '0')
        return { fxOpen: next, fxCollapsed: false, fxViewerCollapsed: false }
      }
      return { fxOpen: next }
    })
  },

  setFxOpen: (open) => {
    writeStorage(FX_OPEN_KEY, open ? '1' : '0')
    if (open) {
      writeStorage(FX_COLLAPSED_KEY, '0')
      writeStorage(FX_VIEWER_COLLAPSED_KEY, '0')
      set({ fxOpen: open, fxCollapsed: false, fxViewerCollapsed: false })
      return
    }
    set({ fxOpen: open })
  },

  toggleFxCollapsed: () => {
    set((s) => {
      const next = !s.fxCollapsed
      writeStorage(FX_COLLAPSED_KEY, next ? '1' : '0')
      if (!next) void refreshLoadedDirs(get) // 展开回来 = 变可见,同上。
      return { fxCollapsed: next }
    })
  },

  toggleFxViewerCollapsed: () => {
    set((s) => {
      const next = !s.fxViewerCollapsed
      writeStorage(FX_VIEWER_COLLAPSED_KEY, next ? '1' : '0')
      return { fxViewerCollapsed: next }
    })
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
    // Register the persisted roots with the main-process fs allowed-roots gate
    // BEFORE listing. On a fresh app start `allowedRoots` is empty (it's
    // in-memory and reset every launch), so `fs:list-dir` → `assertContained`
    // would reject every persisted folder ("fs path outside allowed roots"),
    // the listDir throw would be swallowed, and the panel would fall back to
    // "No folder open" — i.e. the workspace looked like it didn't persist
    // across restarts. `pickWorkspaceFolder` already syncs first; this mirrors
    // it so the restored workspace actually loads.
    await syncAllowedRootsNow(roots)
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
    // Merge against existing in-memory children so already-loaded grandchildren
    // survive a refresh triggered by commitNewNode / pasteIntoDir / moveByDnd.
    // Without this, creating a new file inside an expanded subdir would
    // visually collapse all of that subdir's expanded children (the same
    // bug pattern fixed in refreshWorkspaceRootsForEvent).
    set((s) => ({
      workspaceTree: updateNodeInTree(s.workspaceTree, p, (n) => ({
        ...n,
        childrenLoaded: true,
        children: mergeListedChildren(n.children, children),
      })),
    }))
  },

  openTab: async (p, source) => {
    // 查看器收起时点开文件必须先把查看器露出来,否则「点了没反应」。
    if (get().fxViewerCollapsed) {
      writeStorage(FX_VIEWER_COLLAPSED_KEY, '0')
      set({ fxViewerCollapsed: false })
    }
    const existing = get().tabs.find((t) => t.path === p)
    if (existing) {
      // Bump the scroll token even when the tab is already active — otherwise
      // clicking a chip pointing at the currently-active file would silently
      // do nothing visually (no activeTabId change → no scrollIntoView).
      set((s) => ({ activeTabId: existing.id, scrollActiveTabToken: s.scrollActiveTabToken + 1 }))
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

  openCanvasTab: () => {
    const existing = get().tabs.find((t) => t.kind === 'canvas')
    if (existing) {
      set((s) => ({ ...fxPanelVisibleState(), activeTabId: existing.id, scrollActiveTabToken: s.scrollActiveTabToken + 1 }))
      return
    }
    const tab: FileTab = {
      id: 'canvas:main',
      path: '',
      name: 'Canvas',
      source: 'workspace',
      kind: 'canvas',
      state: null,
      diskContent: '',
      diskMtime: 0,
      dirty: false,
    }
    set((s) => ({ ...fxPanelVisibleState(), activeTabId: tab.id, tabs: [...s.tabs, tab] }))
  },

  openAiChange: async (change) => {
    const key = aiChangeKey(change)
    const existing = get().tabs.find((t) => t.kind === 'ai-change' && t.aiChangeKey === key)
    if (existing) {
      set((s) => ({
        ...fxPanelVisibleState(),
        activeTabId: existing.id,
        scrollActiveTabToken: s.scrollActiveTabToken + 1,
      }))
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
      ...fxPanelVisibleState(),
      activeTabId: id,
      tabs: [...s.tabs, tab],
    }))
  },

  openReference: async (reference) => {
    if (
      reference.source.kind === 'localPath' &&
      (reference.openBehavior === 'code' ||
        reference.openBehavior === 'markdown' ||
        reference.openBehavior === 'image' ||
        reference.openBehavior === 'video' ||
        reference.openBehavior === 'pdf')
    ) {
      const localPath = reference.source.path
      try {
        await get().openTab(localPath, 'workspace')
        const openedTab = get().tabs.find(
          (tab) => tab.kind !== 'reference' && tab.path === localPath,
        )
        if (openedTab && get().activeTabId === openedTab.id) {
          set(fxPanelVisibleState())
          return
        }
      } catch {
        // Fall through to the reference tab so the panel still shows useful details.
      }
    }

    const existing = get().tabs.find((t) => t.referenceKey === reference.id)
    if (existing) {
      set((s) => ({
        ...fxPanelVisibleState(),
        activeTabId: existing.id,
        scrollActiveTabToken: s.scrollActiveTabToken + 1,
      }))
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
      ...fxPanelVisibleState(),
      activeTabId: id,
      tabs: [...s.tabs, tab],
    }))
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

  requestScrollActiveTabIntoView: () =>
    set((s) => ({ scrollActiveTabToken: s.scrollActiveTabToken + 1 })),

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
            // 同 readText:成功返回 `{ mtime }`,失败是 reject。原本查的 `res.ok`
            // 恒为 undefined → 恒真 → 每次都提前 return,于是下面清除冲突态的
            // set(...) 永远不执行。表现是:盘其实写成功了,但冲突横幅不消失、
            // 标签页内容不更新,按钮看起来像死键。
            try {
              await api.fs.writeText(tab.path, conflict.diskContent)
            } catch {
              // 写盘真失败:保留冲突态让用户重试
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

  revealPath: async (absPath) => {
    if (typeof absPath !== 'string' || absPath.length === 0) return
    get().setFxOpen(true)

    const source = inferSource(get().workspaceTree, absPath)
    if (source === 'workspace') {
      // Expand each ancestor dir from its root down so the target node exists
      // in the tree before we select + scroll to it. expandDir is a no-op for
      // already-loaded dirs (it merges), so this is safe to call repeatedly.
      const root = get().workspaceTree.find((n) => n.path === absPath || isDescendantPath(n.path, absPath))
      if (root) {
        for (const dir of ancestorChain(root.path, absPath)) {
          const node = findNode(get().workspaceTree, dir)
          if (node && node.kind === 'dir' && !node.childrenLoaded) {
            try {
              await get().expandDir(dir, 'workspace')
            } catch {
              // Best-effort: a missing/unreadable dir shouldn't abort reveal.
            }
          }
        }
      }
    } else if (get().attachmentsTree.length === 0) {
      try {
        await get().refreshAttachmentsTree()
      } catch {
        // Best-effort.
      }
    }

    get().selectNode(absPath, 'replace')

    // Also open it in the right-pane viewer so the file is actually shown
    // (image preview / code), not just highlighted in the tree.
    try {
      get().openTab(absPath, source)
    } catch {
      // Best-effort: a non-openable path shouldn't abort the reveal.
    }

    // Ask the mounted FileTreeNodes to open ancestors + scroll the match into
    // view. Fire once now, then again after a tick so rows that only mount
    // *after* their parent opens (deep workspace dirs) still catch the request.
    if (typeof window !== 'undefined') {
      const fire = (): void => {
        window.dispatchEvent(new CustomEvent('file-explorer:reveal', { detail: { path: absPath } }))
      }
      fire()
      setTimeout(fire, 80)
    }
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

  moveByDnd: async (sources, destDir) => {
    if (sources.length === 0) return { ok: false, reason: 'nothing to move' }
    const normalized = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
    const dest = normalized(destDir)
    // VSCode silently no-ops same-dir drops; without this the UI would round-
    // trip to main and our `uniquePath` helper would produce spurious "a copy.ts"
    // suffixes for users who just dragged within the same folder.
    const allSameDir = sources.every((s) => {
      const norm = normalized(s)
      const idx = Math.max(norm.lastIndexOf('/'))
      const parent = idx > 0 ? norm.slice(0, idx) : norm
      return parent === dest
    })
    if (allSameDir) return { ok: true }
    // Dir-into-self / dir-into-descendant is the classic data-loss footgun.
    // Main also enforces this, but the UI guard avoids a confusing error toast
    // round-trip when the user obviously can't drop here.
    for (const src of sources) {
      const s = normalized(src)
      if (s === dest || dest.startsWith(`${s}/`)) {
        return { ok: false, reason: '不能将目录移动到自身或其子目录' }
      }
    }
    const api = getApi()
    if (!api.fs.move) return { ok: false, reason: 'move API not available' }
    const res = await api.fs.move(sources, destDir)
    if (!res.ok) return { ok: false, reason: res.reason }
    // Refresh both the destination (newly-arrived items must appear) and the
    // affected source directories (the items left). For sources we only need
    // their immediate parents — chokidar would do this too, but the user
    // expects an instant update.
    const sourceDirs = new Set<string>()
    for (const src of sources) {
      const s = normalized(src)
      const idx = Math.max(s.lastIndexOf('/'))
      if (idx > 0) sourceDirs.add(s.slice(0, idx))
    }
    const destSource = inferSource(get().workspaceTree, destDir)
    try {
      await get().expandDir(destDir, destSource)
    } catch {
      // listDir failure here is non-fatal — chokidar will catch up.
    }
    for (const dir of sourceDirs) {
      const src = inferSource(get().workspaceTree, dir)
      try {
        await get().expandDir(dir, src)
      } catch {
        // same as above
      }
    }
    return { ok: true }
  },

  importExternalByDnd: async (sources, destDir) => {
    if (sources.length === 0) return { ok: false, reason: 'nothing to import' }
    const api = getApi()
    if (!api.fs.importExternal) return { ok: false, reason: 'importExternal API not available' }
    const res = await api.fs.importExternal(sources, destDir)
    const written = res.ok ? res.written : (res.written ?? [])

    // Refresh + select for any written files — happens on full success AND
    // on partial failure, so the user immediately sees what landed even
    // when a downstream source failed.
    if (written.length > 0) {
      const destSource = inferSource(get().workspaceTree, destDir)
      try {
        await get().expandDir(destDir, destSource)
      } catch {
        // listDir failure is non-fatal — chokidar will catch up.
      }
      get().selectNode(written[written.length - 1], 'replace')
    }

    if (!res.ok) return { ok: false, reason: res.reason, written: res.written }
    return { ok: true, written: res.written }
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
    const readText = api.fs.readText
    if (!readText) {
      return { ok: false, reason: '不支持读取文本' }
    }
    // readText 成功返回 `{ content, mtime }`,失败是 **reject** ——
    // fsIpc.handleReadText 直接 throw,而 preload 的 safeInvoke 只是
    // `ipcRenderer.invoke`,不把异常包成结果对象。
    //
    // 这里原本按 `{ ok, text, reason }` 判别联合来读,而那个形状从不存在:`.ok`
    // 恒为 undefined → `!undefined` 恒为 true → **每次都走失败分支**,文件对比
    // 标签页从来就打不开(报「读取左侧失败: undefined」)。本文件别处(见
    // 上面 watch 回调与 openFile)一直都是直接取 `.content`,这一处是异类。
    const read = async (p: string, side: string) => {
      try {
        return { ok: true as const, content: (await readText(p)).content }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return { ok: false as const, reason: `读取${side}失败: ${detail}` }
      }
    }
    const [leftRes, rightRes] = await Promise.all([read(leftPath, '左侧'), read(rightPath, '右侧')])
    if (!leftRes.ok) return { ok: false, reason: leftRes.reason }
    if (!rightRes.ok) return { ok: false, reason: rightRes.reason }

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
        leftContent: leftRes.content,
        rightContent: rightRes.content,
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

  ensureSubscriptions: () => {
    ensureWatchSubscription(get)
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

/** True when `target` lives under directory `root` (same separator family). */
function isDescendantPath(root: string, target: string): boolean {
  if (!root || !target || root === target) return false
  const sep = root.includes('\\') || target.includes('\\') ? '\\' : '/'
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  return target.startsWith(rootWithSep)
}

/**
 * Ancestor directory chain from `rootPath` (inclusive) down to the parent dir
 * of `filePath` (inclusive), in root-first order. Used by `revealPath` to
 * expand each level before selecting a nested file.
 */
function ancestorChain(rootPath: string, filePath: string): string[] {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const dirs: string[] = []
  // Start from the file's parent dir.
  let cur = filePath
  const fileSlash = cur.lastIndexOf(sep)
  cur = fileSlash > 0 ? cur.slice(0, fileSlash) : cur
  while (cur.length >= rootPath.length && (cur === rootPath || cur.startsWith(rootPath))) {
    dirs.unshift(cur)
    if (cur === rootPath) break
    const idx = cur.lastIndexOf(sep)
    if (idx <= 0) break
    cur = cur.slice(0, idx)
  }
  return dirs
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

