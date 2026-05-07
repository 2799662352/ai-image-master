import { create } from 'zustand'
import type {
  AgentAttachmentInput,
  AgentCancelPayload,
  AgentSendMessagePayload,
  AgentStreamEvent,
  ItemDeltaPatch,
} from '../../../../types/agent'
import type { AttachmentRef, Message, TimelineItem } from '../../../../types/agent-timeline'
import { upsertItemInLastMessage } from '../../../../types/agent-timeline'
import { AGENT_MODELS, DEFAULT_MODEL_ID } from './models'

const SELECTED_MODEL_STORAGE_KEY = 'catimation.agent.selectedModel'
const PANEL_WIDTH_STORAGE_KEY = 'catimation.agent.panelWidth'
const PANEL_WIDTH_DEFAULT = 420
const PANEL_WIDTH_MIN = 360
const PANEL_WIDTH_MAX = 720

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

type AgentElectronApi = {
  agent?: {
    sendMessage: (payload: AgentSendMessagePayload) => Promise<{ threadId: string }>
    cancel: (payload: AgentCancelPayload) => Promise<unknown>
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
  isRunning: boolean
  error?: string
  selectedModelId: string
  messages: Message[]
  panelWidth: number
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
  send: () => Promise<void>
  cancel: () => Promise<void>
  applyEvent: (event: AgentStreamEvent) => void
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  messages: [],
  isRunning: false,
  selectedModelId: readPersistedModelId(),
  panelWidth: readPersistedPanelWidth(),
  preview: { open: false, images: [], index: 0 },
  openPreview: (images, startIndex) =>
    set({
      preview: {
        open: true,
        images,
        index: Math.max(0, Math.min(startIndex, images.length - 1)),
      },
    }),
  closePreview: () => set((s) => ({ preview: { ...s.preview, open: false } })),
  nextPreview: () =>
    set((s) => ({
      preview: { ...s.preview, index: Math.min(s.preview.index + 1, s.preview.images.length - 1) },
    })),
  prevPreview: () =>
    set((s) => ({
      preview: { ...s.preview, index: Math.max(s.preview.index - 1, 0) },
    })),
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
      const refs: AttachmentRef[] = attachments.map((a) => ({
        id: createId(),
        kind: a.mime.startsWith('image/') ? 'image' : 'file',
        name: a.name,
        mime: a.mime,
        size: a.size,
        uri: a.path ?? '',
      }))
      items.push({ type: 'attachment', id: createId(), startedAt: now, attachments: refs })
    }
    if (content.length > 0) {
      items.push({ type: 'text', id: createId(), startedAt: now, content })
    }
    const userMsg: Message = { id: createId(), role: 'user', createdAt: now, items }

    set((current) => ({
      input: '',
      attachments: [],
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
    } catch (error) {
      set((current) => ({
        input: content,
        attachments,
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
}))

export type { AgentChatState }
export type { AgentChatMessage } from './types'
