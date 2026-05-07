import { create } from 'zustand'
import type {
  AgentAttachmentInput,
  AgentArtifact,
  AgentCancelPayload,
  AgentSendMessagePayload,
  AgentStreamEvent,
} from '../../../../types/agent'
import { AGENT_MODELS, DEFAULT_MODEL_ID } from './models'
import type { AgentChatMessage, AgentChatToolEvent } from './types'

const SELECTED_MODEL_STORAGE_KEY = 'catimation.agent.selectedModel'

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

type AgentElectronApi = {
  agent?: {
    sendMessage: (payload: AgentSendMessagePayload) => Promise<{ threadId: string }>
    cancel: (payload: AgentCancelPayload) => Promise<unknown>
  }
}

interface AgentChatState {
  isOpen: boolean
  threadId?: string
  input: string
  attachments: AgentAttachmentInput[]
  artifacts: AgentArtifact[]
  messages: AgentChatMessage[]
  reasoning: string
  toolEvents: AgentChatToolEvent[]
  isRunning: boolean
  error?: string
  selectedModelId: string
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

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  isOpen: false,
  input: '',
  attachments: [],
  artifacts: [],
  messages: [],
  reasoning: '',
  toolEvents: [],
  isRunning: false,
  selectedModelId: readPersistedModelId(),
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
    if (!content || state.isRunning) return

    const attachments = state.attachments
    const modelId = state.selectedModelId
    set((current) => ({
      input: '',
      attachments: [],
      artifacts: [],
      error: undefined,
      reasoning: '',
      toolEvents: [],
      isRunning: true,
      messages: [...current.messages, { id: createId(), role: 'user', content }],
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

    if (event.type === 'message_delta') {
      set((state) => {
        const last = state.messages[state.messages.length - 1]
        if (last?.role === 'assistant') {
          return {
            messages: [
              ...state.messages.slice(0, -1),
              { ...last, content: last.content + (event.delta ?? '') },
            ],
          }
        }
        return {
          messages: [
            ...state.messages,
            { id: createId(), role: 'assistant', content: event.delta ?? '' },
          ],
        }
      })
    }

    if (event.type === 'reasoning_delta') {
      set((state) => ({ reasoning: state.reasoning + (event.delta ?? '') }))
    }

    if ((event.type === 'tool_call_start' || event.type === 'tool_call_end') && event.tool) {
      set((state) => ({ toolEvents: [...state.toolEvents, event.tool!] }))
    }

    if (event.type === 'artifact_created' && event.artifact) {
      set((state) => ({ artifacts: [...state.artifacts, event.artifact!] }))
    }

    if (event.type === 'error') {
      set({ error: event.error ?? 'Agent failed', isRunning: false })
    }

    if (event.type === 'turn_completed' || event.type === 'cancelled') {
      set({ isRunning: false })
    }
  },
}))

export type { AgentChatState, AgentChatMessage }
