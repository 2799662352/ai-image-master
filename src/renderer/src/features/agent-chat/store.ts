import { create } from 'zustand'
import type {
  AgentAttachmentInput,
  AgentCancelPayload,
  AgentSendMessagePayload,
  AgentStreamEvent,
  AgentThreadSummary,
  AgentTokenUsage,
  ItemDeltaPatch,
} from '../../../../types/agent'
import type { AgentReference } from '../../../../types/agent-reference'
import type { AttachmentRef, Message, TimelineItem } from '../../../../types/agent-timeline'
import { upsertItemInLastMessage } from '../../../../types/agent-timeline'
import { AGENT_MODELS, DEFAULT_MODEL_ID } from './models'
import { useFileExplorerStore } from '../file-explorer/store'

const SELECTED_MODEL_STORAGE_KEY = 'catimation.agent.selectedModel'
const PANEL_WIDTH_STORAGE_KEY = 'catimation.agent.panelWidth'
const PANEL_WIDTH_DEFAULT = 420
const PANEL_WIDTH_MIN = 360
const PANEL_WIDTH_MAX = 720

const SIDEBAR_OPEN_STORAGE_KEY = 'catimation.agent.sidebarOpen'
const SIDEBAR_WIDTH_STORAGE_KEY = 'catimation.agent.sidebarWidth'
const SIDEBAR_WIDTH_DEFAULT = 240
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 360
const SIDEBAR_OPEN_DEFAULT = true
const THREAD_LIST_TITLE_REFRESH_DELAYS_MS = [500, 2_500, 8_500] as const

function scheduleThreadListTitleRefreshes(run: () => void): void {
  for (const delay of THREAD_LIST_TITLE_REFRESH_DELAYS_MS) {
    setTimeout(run, delay)
  }
}

function readPersistedModelId(): string {
  try {
    const raw = globalThis.localStorage?.getItem(SELECTED_MODEL_STORAGE_KEY)
    if (!raw) return DEFAULT_MODEL_ID
    return AGENT_MODELS.some((m) => m.id === raw) ? raw : DEFAULT_MODEL_ID
  } catch {
    return DEFAULT_MODEL_ID
  }
}

function persistModelId(id: string): void {
  try {
    globalThis.localStorage?.setItem(SELECTED_MODEL_STORAGE_KEY, id)
  } catch {
    // localStorage unavailable (SSR / sandbox); silently ignore.
  }
}

function readPersistedPanelWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(PANEL_WIDTH_STORAGE_KEY)
    if (!raw) return PANEL_WIDTH_DEFAULT
    const n = parseInt(raw, 10)
    if (Number.isNaN(n) || n < PANEL_WIDTH_MIN || n > PANEL_WIDTH_MAX) return PANEL_WIDTH_DEFAULT
    return n
  } catch {
    return PANEL_WIDTH_DEFAULT
  }
}

function readPersistedSidebarOpen(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_OPEN_STORAGE_KEY)
    if (raw == null) return SIDEBAR_OPEN_DEFAULT
    return raw === 'true'
  } catch {
    return SIDEBAR_OPEN_DEFAULT
  }
}

function readPersistedSidebarWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (!raw) return SIDEBAR_WIDTH_DEFAULT
    const n = parseInt(raw, 10)
    if (Number.isNaN(n) || n < SIDEBAR_WIDTH_MIN || n > SIDEBAR_WIDTH_MAX) return SIDEBAR_WIDTH_DEFAULT
    return n
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

function persistSidebarOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open))
  } catch {
    /* localStorage unavailable; silently ignore */
  }
}

function persistSidebarWidth(w: number): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(w))
  } catch {
    /* localStorage unavailable; silently ignore */
  }
}

type AgentElectronApi = {
  agent?: {
    sendMessage: (payload: AgentSendMessagePayload) => Promise<{ threadId: string }>
    cancel: (payload: AgentCancelPayload) => Promise<unknown>
    listThreads?: () => Promise<AgentThreadSummary[]>
    openThread?: (id: string) => Promise<unknown>
    renameThread?: (id: string, title: string) => Promise<void>
    deleteThread?: (id: string) => Promise<void>
  }
}

interface PreviewState {
  open: boolean
  images: AttachmentRef[]
  index: number
}

interface AgentChatState {
  isOpen: boolean
  threadId?: string
  input: string
  attachments: AgentAttachmentInput[]
  pendingReferences: AgentReference[]
  isRunning: boolean
  error?: string
  selectedModelId: string
  messages: Message[]
  panelWidth: number
  /**
   * Latest cumulative token usage reported by the codex `app-server` for the
   * active thread. `undefined` until the first `thread/tokenUsage/updated`
   * arrives. Drives the header context-usage meter (covers the regression
   * "甚至没有个圈圈展示上下文压缩进度").
   */
  tokenUsage?: AgentTokenUsage
  setPanelWidth: (width: number) => void
  preview: PreviewState
  openPreview: (images: AttachmentRef[], startIndex: number) => void
  closePreview: () => void
  nextPreview: () => void
  prevPreview: () => void
  toggle: () => void
  setInput: (input: string) => void
  setError: (error?: string) => void
  setSelectedModel: (modelId: string) => void
  addAttachment: (attachment: AgentAttachmentInput) => void
  removeAttachment: (name: string) => void
  addPendingReference: (reference: AgentReference) => void
  removePendingReference: (referenceId: string) => void
  clearPendingReferences: () => void
  send: () => Promise<void>
  cancel: () => Promise<void>
  newThread: () => void
  switchThread: (threadId: string) => Promise<void>
  applyEvent: (event: AgentStreamEvent) => void

  // ----- Sidebar / thread list -----
  sidebarOpen: boolean
  sidebarWidth: number
  threadList: AgentThreadSummary[]
  threadListLoading: boolean
  bootstrapped: boolean

  bootstrap: () => Promise<void>
  refreshThreadList: () => Promise<void>
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  renameThread: (threadId: string, title: string) => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Build a renderer-loadable URI for an attachment so `<img src>` is never
 * an empty string (which both triggers the React "empty src" warning and
 * causes the browser to refetch the page).
 *
 * - `buffer` (the common path: `<input type=file>` flow) becomes a blob URL
 *   we can hand straight to the DOM. The blob keeps the bytes alive until
 *   the document unloads or the URL is revoked, which is plenty for an
 *   in-flight chat turn.
 * - `path` (Electron drag-drop with file path exposed) is kept as a
 *   non-empty fallback even though most Electron renderers can't load
 *   `D:\...` directly without a custom protocol; downgrading kind handles
 *   the visual fallback.
 * - When neither is usable we return undefined so the caller can downgrade
 *   to a 'file' chip instead of rendering a broken `<img>`.
 */
function buildAttachmentUri(a: AgentAttachmentInput): string | undefined {
  const blobCtor = globalThis.Blob
  const urlCtor = globalThis.URL
  if (a.buffer && blobCtor && typeof urlCtor?.createObjectURL === 'function') {
    try {
      return urlCtor.createObjectURL(new blobCtor([a.buffer], { type: a.mime || 'application/octet-stream' }))
    } catch {
      // Fall through to path / undefined.
    }
  }
  if (typeof a.path === 'string' && a.path.length > 0) return a.path
  return undefined
}

function getAgentApi(): NonNullable<AgentElectronApi['agent']> {
  const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
  if (!agent) throw new Error('Electron agent API is unavailable')
  return agent
}

function resolveItemId(event: { itemId: string; itemType: TimelineItem['type']; turnId?: string }): string {
  if (event.itemId && event.itemId.length > 0) return event.itemId
  return `${event.itemType}-${event.turnId ?? 'no-turn'}`
}

function createItemFromStarted(itemType: TimelineItem['type'], itemId: string, payload: Record<string, unknown>): TimelineItem {
  const now = Date.now()
  switch (itemType) {
    case 'text':
      return { type: 'text', id: itemId, startedAt: now, content: '' }
    case 'reasoning':
      return { type: 'reasoning', id: itemId, startedAt: now, content: '' }
    case 'shell':
      return {
        type: 'shell',
        id: itemId,
        startedAt: now,
        command: typeof payload.command === 'string' ? payload.command : '',
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        stdout: '',
        stderr: '',
      }
    case 'fileEdit':
      return { type: 'fileEdit', id: itemId, startedAt: now, changes: [], totalAdded: 0, totalRemoved: 0 }
    case 'attachment':
      return { type: 'attachment', id: itemId, startedAt: now, attachments: [] }
    case 'artifact':
      return { type: 'artifact', id: itemId, startedAt: now, artifacts: [] }
    case 'activity': {
      const status = payload.status
      const safeStatus =
        status === 'running' || status === 'success' || status === 'error' || status === 'cancelled'
          ? status
          : 'running'
      return {
        type: 'activity',
        id: itemId,
        startedAt: now,
        kind: typeof payload.kind === 'string' ? payload.kind : 'activity',
        ...(typeof payload.label === 'string' ? { label: payload.label } : {}),
        ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
        status: safeStatus,
      }
    }
  }
}

function ensureAssistantMessage(messages: Message[]): Message[] {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') return messages
  const newMsg: Message = { id: createId(), role: 'assistant', createdAt: Date.now(), items: [] }
  return [...messages, newMsg]
}

function applyItemPatch(item: TimelineItem, patch: ItemDeltaPatch): TimelineItem {
  if (patch.kind === 'appendText') {
    const { field, text } = patch
    if (field === 'content') {
      if (item.type === 'text' || item.type === 'reasoning') {
        return { ...item, content: item.content + text }
      }
      return item
    }
    if (item.type === 'shell' && (field === 'stdout' || field === 'stderr')) {
      return { ...item, [field]: item[field] + text }
    }
    return item
  }
  // type: item.type reaffirmation guards the discriminant from patch.fields.
  return { ...item, ...patch.fields, type: item.type } as typeof item
}

function applyItemCompleted(item: TimelineItem, final: Record<string, unknown>): TimelineItem {
  return { ...item, ...final, type: item.type, endedAt: Date.now() } as typeof item
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  isOpen: false,
  input: '',
  attachments: [],
  pendingReferences: [],
  messages: [],
  isRunning: false,
  selectedModelId: readPersistedModelId(),
  panelWidth: readPersistedPanelWidth(),
  tokenUsage: undefined,
  sidebarOpen: readPersistedSidebarOpen(),
  sidebarWidth: readPersistedSidebarWidth(),
  threadList: [],
  threadListLoading: false,
  bootstrapped: false,
  preview: { open: false, images: [], index: 0 },
  openPreview: (images, startIndex) => {
    if (images.length === 0) return
    set({
      preview: {
        open: true,
        images,
        index: Math.max(0, Math.min(startIndex, images.length - 1)),
      },
    })
  },
  closePreview: () => set((s) => ({ preview: { ...s.preview, open: false } })),
  nextPreview: () =>
    set((s) => {
      if (s.preview.images.length === 0) return {}
      return {
        preview: { ...s.preview, index: Math.min(s.preview.index + 1, s.preview.images.length - 1) },
      }
    }),
  prevPreview: () =>
    set((s) => {
      if (s.preview.images.length === 0) return {}
      return {
        preview: { ...s.preview, index: Math.max(s.preview.index - 1, 0) },
      }
    }),
  setPanelWidth: (width) => {
    const clamped = Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, width))
    try {
      globalThis.localStorage?.setItem(PANEL_WIDTH_STORAGE_KEY, String(clamped))
    } catch {
      // localStorage unavailable (SSR / sandbox); silently ignore.
    }
    set({ panelWidth: clamped })
  },
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  setInput: (input) => set({ input }),
  setError: (error) => set({ error }),
  setSelectedModel: (modelId) => {
    if (!AGENT_MODELS.some((m) => m.id === modelId)) return
    persistModelId(modelId)
    set({ selectedModelId: modelId })
  },
  addAttachment: (attachment) => set((state) => ({ attachments: [...state.attachments, attachment] })),
  removeAttachment: (name) => set((state) => ({
    attachments: state.attachments.filter((item) => item.name !== name),
  })),
  addPendingReference: (reference) =>
    set((state) => ({
      pendingReferences: state.pendingReferences.some((item) => item.id === reference.id)
        ? state.pendingReferences
        : [...state.pendingReferences, reference],
    })),
  removePendingReference: (referenceId) =>
    set((state) => ({
      pendingReferences: state.pendingReferences.filter((item) => item.id !== referenceId),
    })),
  clearPendingReferences: () => set({ pendingReferences: [] }),
  send: async () => {
    const state = get()
    const content = state.input.trim()
    const attachments = state.attachments
    if (state.isRunning) return
    if (!content && attachments.length === 0) return

    const modelId = state.selectedModelId
    const now = Date.now()
    const items: TimelineItem[] = []
    if (attachments.length > 0) {
      const refs: AttachmentRef[] = attachments.map((a) => {
        const uri = buildAttachmentUri(a)
        const isImage = a.mime.startsWith('image/')
        // Only claim 'image' when we actually have something the renderer can
        // load — otherwise downgrade to 'file' so the card renders a 📄 chip
        // instead of `<img src="">`.
        const kind: AttachmentRef['kind'] = isImage && typeof uri === 'string' && uri.length > 0 ? 'image' : 'file'
        return {
          id: createId(),
          kind,
          name: a.name,
          mime: a.mime,
          size: a.size,
          uri: uri ?? '',
        }
      })
      items.push({ type: 'attachment', id: createId(), startedAt: now, attachments: refs })
    }
    if (content.length > 0) {
      items.push({ type: 'text', id: createId(), startedAt: now, content })
    }
    const userMsg: Message = { id: createId(), role: 'user', createdAt: now, items }

    set((current) => ({
      input: '',
      attachments: [],
      pendingReferences: [],
      error: undefined,
      isRunning: true,
      messages: [...current.messages, userMsg],
    }))

    try {
      const result = await getAgentApi().sendMessage({
        threadId: state.threadId,
        content,
        attachments,
        currentPage: window.location.hash.slice(1),
        model: modelId,
      })
      set({ threadId: result.threadId })
      // PHASE-1-INVARIANT: pendingReferences are renderer-only chips. Do not
      // add them to AgentSendMessagePayload until the Phase 2 payload contract lands.
      get().clearPendingReferences()
      void useFileExplorerStore.getState().refreshAttachmentsTree().catch(() => undefined)
    } catch (error) {
      set((current) => ({
        input: content,
        attachments,
        pendingReferences: state.pendingReferences,
        isRunning: false,
        error: error instanceof Error ? error.message : String(error),
        messages: current.messages.slice(0, -1),
      }))
    }
  },
  cancel: async () => {
    const threadId = get().threadId
    if (!threadId) return
    try {
      await getAgentApi().cancel({ threadId })
      set({ isRunning: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        isRunning: false,
      })
    }
  },
  newThread: () =>
    set({
      threadId: undefined,
      messages: [],
      isRunning: false,
      error: undefined,
      tokenUsage: undefined,
    }),
  switchThread: async (threadId: string) => {
    const agent = (window as Window & { electronAPI?: { agent?: { openThread?: (id: string) => Promise<unknown> } } })
      .electronAPI?.agent
    if (!agent?.openThread) return
    const thread = await agent.openThread(threadId)
    if (!thread || typeof thread !== 'object') return

    const rawMessages = (thread as { messages?: unknown }).messages
    const messages: Message[] = Array.isArray(rawMessages)
      ? rawMessages.map((row: unknown) => {
          const r = row as {
            id: string
            role: string
            items: string | unknown[] | null
            createdAt?: string | Date
          }
          let parsedItems: unknown = r.items
          if (typeof parsedItems === 'string') {
            try {
              parsedItems = JSON.parse(parsedItems)
            } catch {
              parsedItems = []
            }
          }
          const role: Message['role'] =
            r.role === 'user' || r.role === 'assistant' ? r.role : 'assistant'
          return {
            id: r.id,
            role,
            items: Array.isArray(parsedItems) ? (parsedItems as TimelineItem[]) : [],
            createdAt:
              typeof r.createdAt === 'string'
                ? Date.parse(r.createdAt)
                : r.createdAt instanceof Date
                  ? r.createdAt.getTime()
                  : Date.now(),
          }
        })
      : []

    set({
      threadId,
      messages,
      isRunning: false,
      error: undefined,
      // Token usage is per-thread; reset until the next
      // thread/tokenUsage/updated arrives.
      tokenUsage: undefined,
    })
  },
  applyEvent: (event) => {
    const activeThreadId = get().threadId
    if (activeThreadId && event.threadId !== activeThreadId) return

    switch (event.type) {
      case 'thread_created':
        break
      case 'item_started': {
        const itemId = resolveItemId(event)
        set((state) => {
          const msgs = ensureAssistantMessage(state.messages)
          const next = upsertItemInLastMessage(
            msgs,
            itemId,
            () => createItemFromStarted(event.itemType, itemId, event.payload),
            (item) => item,
          )
          return { messages: next }
        })
        break
      }
      case 'item_delta': {
        const itemId = resolveItemId(event)
        set((state) => {
          const msgs = ensureAssistantMessage(state.messages)
          const next = upsertItemInLastMessage(
            msgs,
            itemId,
            () => createItemFromStarted(event.itemType, itemId, {}),
            (item) => applyItemPatch(item, event.patch),
          )
          return { messages: next }
        })
        break
      }
      case 'item_completed': {
        const itemId = resolveItemId(event)
        set((state) => {
          const msgs = ensureAssistantMessage(state.messages)
          const next = upsertItemInLastMessage(
            msgs,
            itemId,
            () => createItemFromStarted(event.itemType, itemId, {}),
            (item) => applyItemCompleted(item, event.final),
          )
          return { messages: next }
        })
        break
      }
      case 'turn_completed':
        set({ isRunning: false })
        scheduleThreadListTitleRefreshes(() => void get().refreshThreadList())
        break
      case 'token_usage_updated':
        // Just overwrite — Codex sends cumulative counts. The header meter
        // reads `tokenUsage.contextUsage / contextWindow` if both are
        // present, otherwise falls back to inputTokens+outputTokens.
        set({ tokenUsage: event.usage })
        break
      case 'error':
        set({ error: event.error, isRunning: false })
        break
      case 'cancelled':
        set({ isRunning: false })
        break
      default: {
        // exhaustiveness: every AgentStreamEvent variant must be handled above.
        const _exhaustive: never = event
        void _exhaustive
        break
      }
    }
  },

  bootstrap: async () => {
    if (get().bootstrapped || get().threadListLoading) return
    set({ threadListLoading: true })
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.listThreads) {
      set({ threadListLoading: false, bootstrapped: true })
      return
    }
    try {
      const list = await agent.listThreads()
      set({ threadList: list, bootstrapped: true })
      const top = list[0]
      if (top && agent.openThread) {
        await get().switchThread(top.id)
      }
    } catch (err) {
      // Leave `bootstrapped` false so a follow-up open can retry; surface the
      // failure on the panel so the user knows why the list is empty.
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ threadListLoading: false })
    }
  },

  refreshThreadList: async () => {
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.listThreads) return
    try {
      const list = await agent.listThreads()
      set({ threadList: list })
    } catch {
      /* swallow refresh errors — stale list is preferable to a banner */
    }
  },

  toggleSidebar: () => {
    const next = !get().sidebarOpen
    persistSidebarOpen(next)
    set({ sidebarOpen: next })
  },

  setSidebarWidth: (width) => {
    const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
    persistSidebarWidth(clamped)
    set({ sidebarWidth: clamped })
  },

  renameThread: async (threadId, title) => {
    const trimmed = title.trim()
    if (!threadId || trimmed.length === 0) return
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.renameThread) return
    await agent.renameThread(threadId, trimmed)
    await get().refreshThreadList()
  },

  deleteThread: async (threadId) => {
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.deleteThread) return
    await agent.deleteThread(threadId)
    if (get().threadId === threadId) {
      // Drop into the empty-thread state and let the user pick another row.
      set({ threadId: undefined, messages: [], tokenUsage: undefined, error: undefined, isRunning: false })
    }
    await get().refreshThreadList()
  },
}))

export type { AgentChatState }
export type { AgentChatMessage } from './types'
