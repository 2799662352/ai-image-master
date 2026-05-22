import { create } from 'zustand'
import type {
  AgentAttachmentInput,
  AgentCancelPayload,
  AgentApiResult,
  AgentNotice,
  AgentSendMessagePayload,
  AgentSendMessageResult,
  AgentStreamEvent,
  AgentThreadSummary,
  AgentTokenUsage,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexSkillSummary,
  CodexSkillsSummary,
  CodexThreadSummary,
  ItemDeltaPatch,
} from '../../../../types/agent'
import type { AgentReference } from '../../../../types/agent-reference'
import type { AttachmentRef, Message, PlanStep, TimelineItem } from '../../../../types/agent-timeline'
import { upsertItemInLastMessage } from '../../../../types/agent-timeline'
import { AGENT_MODELS, DEFAULT_MODEL_ID } from './models'
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL_ID } from './videoModels'
import { useFileExplorerStore } from '../file-explorer/store'

const SELECTED_MODEL_STORAGE_KEY = 'catimation.agent.selectedModel'
const SELECTED_VIDEO_MODEL_STORAGE_KEY = 'catimation.agent.selectedVideoModel'
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

function readPersistedVideoModelId(): string {
  try {
    const raw = globalThis.localStorage?.getItem(SELECTED_VIDEO_MODEL_STORAGE_KEY)
    if (!raw) return DEFAULT_VIDEO_MODEL_ID
    return VIDEO_MODELS.some((m) => m.id === raw) ? raw : DEFAULT_VIDEO_MODEL_ID
  } catch {
    return DEFAULT_VIDEO_MODEL_ID
  }
}

function persistVideoModelId(id: string): void {
  try {
    globalThis.localStorage?.setItem(SELECTED_VIDEO_MODEL_STORAGE_KEY, id)
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
    sendMessage: (payload: AgentSendMessagePayload) => Promise<AgentSendMessageResult>
    cancel: (payload: AgentCancelPayload) => Promise<unknown>
    listThreads?: () => Promise<AgentThreadSummary[]>
    openThread?: (id: string) => Promise<unknown>
    renameThread?: (id: string, title: string) => Promise<void>
    deleteThread?: (id: string) => Promise<void>
    respondApproval?: (response: CodexApprovalResponse) => Promise<AgentApiResult>
    listCodexThreads?: () => Promise<CodexThreadSummary[]>
    forkCodexThread?: (threadId: string) => Promise<CodexThreadSummary>
    getSkillsSummary?: () => Promise<CodexSkillsSummary>
  }
}

/**
 * Extract `$skill-name` tokens from a chat input. Mirrors the codex
 * app-server marker syntax — `$name` must be at the start of input or
 * preceded by whitespace, and runs until the next non-`[\w-]` character.
 * Requires the first char to be alpha/underscore so dollar amounts like
 * `$42` and shell exits like `$0` are not mistakenly forwarded as skills.
 *
 * Example: in `"please use $skill-creator and $compactor now"` we extract
 * `["skill-creator", "compactor"]`. Used by `send()` to attach
 * `{type:"skill", name, path}` input items to the codex turn.
 */
export function extractSkillTokens(text: string): string[] {
  const out: string[] = []
  const re = /(?:^|\s)\$([A-Za-z_][\w-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(m[1])
  }
  return out
}

interface PreviewState {
  open: boolean
  images: AttachmentRef[]
  index: number
}

/**
 * One stashed exchange: the user message and every assistant message
 * that ran in response to it. `originalIndex` is where the user message
 * sat in `messages` at the time of rewind so a subsequent restore can
 * splice the slice back into roughly its original spot.
 */
export interface RewoundTurn {
  id: string
  rewoundAt: number
  originalIndex: number
  messages: Message[]
  /** First-line preview of the user message (used by the drawer). */
  preview: string
}

interface AgentChatState {
  isOpen: boolean
  threadId?: string
  input: string
  attachments: AgentAttachmentInput[]
  pendingReferences: AgentReference[]
  pendingApprovals: CodexApprovalRequest[]
  /**
   * Transient notices surfaced from codex `app-server` notifications:
   * configWarning, deprecationNotice, model rerouting, hook lifecycle, and
   * auto-approval review pulses. Newest first. UI renders dismissible
   * banners; warnings stick around, info notices auto-fade.
   */
  notices: AgentNotice[]
  /**
   * When set, the user is editing a previous message in place. The full
   * `MentionInput` composer is rendered at the message's position (the
   * footer composer is hidden) so the edit UI is *literally* the same
   * component / chrome / model picker / Send button — just relocated.
   * Mirrors Cursor's "edit & rerun" UX.
   */
  editingMessageId?: string
  /**
   * Snapshot of the bottom composer's `input` / `attachments` /
   * `pendingReferences` taken when the user enters edit mode, so cancelling
   * the edit restores their in-flight draft instead of nuking it.
   */
  draftBackup?: {
    input: string
    attachments: AgentAttachmentInput[]
    pendingReferences: AgentReference[]
  }
  /**
   * Stash of "rewound" turns (a user message + every assistant message
   * that followed it, up to but not including the next user message).
   * Each entry preserves the slice plus the index it occupied in
   * `messages` so a later restore can splice it back in place. The drawer
   * UI renders these as one-line clickable rows above the bottom composer.
   * Newest first.
   */
  rewoundTurns: RewoundTurn[]
  isRunning: boolean
  error?: string
  selectedModelId: string
  /**
   * Default Gemini model id for the bundled apiyi-mcp video understanding
   * tool. Persisted to localStorage and pushed to the main process via
   * `electronAPI.agent.setApiyiVideoModel`, which writes
   * `mcp_servers.apiyi.env.GEMINI_MODEL` in ~/.codex/config.toml.
   */
  selectedVideoModelId: string
  messages: Message[]
  panelWidth: number
  /**
   * Latest cumulative token usage reported by the codex `app-server` for the
   * active thread. `undefined` until the first `thread/tokenUsage/updated`
   * arrives. Drives the header context-usage meter (covers the regression
   * "甚至没有个圈圈展示上下文压缩进度").
   */
  tokenUsage?: AgentTokenUsage
  /**
   * Per-thread dedup tracker for the proactive 70% context-window warning
   * (see openai/codex#10823 — once context is past ~95%, Codex's
   * auto-compact has no remaining budget to emit a summary and fails).
   *
   * Key: `${threadId}:l1` (l1 = "level 1" / 70%; reserved for future tiers
   * such as l2/85% or l3/95%). Once set, we never re-push the same notice
   * for the same thread within this session — even if the user dismisses
   * and usage briefly drops then climbs back over the threshold. Cleared
   * on `newThread` and `applyEvent('cancelled')` (fresh thread => fresh
   * watermark surface).
   *
   * Intentionally kept in zustand state (not module-scoped) so tests can
   * inspect/reset it deterministically via `useAgentChatStore.setState`.
   */
  contextWatermarkSeen: Record<string, true>
  setPanelWidth: (width: number) => void
  preview: PreviewState
  openPreview: (images: AttachmentRef[], startIndex: number) => void
  closePreview: () => void
  nextPreview: () => void
  prevPreview: () => void
  toggle: () => void
  setInput: (input: string) => void
  appendInputText: (text: string) => void
  setError: (error?: string) => void
  setSelectedModel: (modelId: string) => void
  setSelectedVideoModel: (modelId: string) => void
  addAttachment: (attachment: AgentAttachmentInput) => void
  removeAttachment: (name: string) => void
  removeAttachmentForReference: (reference: AgentReference) => void
  addPendingReference: (reference: AgentReference) => void
  removePendingReference: (referenceId: string) => void
  clearPendingReferences: () => void
  addApprovalRequest: (request: CodexApprovalRequest) => void
  removeApprovalRequest: (id: string) => void
  pushNotice: (notice: AgentNotice) => void
  dismissNotice: (id: string) => void
  respondToApproval: (response: CodexApprovalResponse) => Promise<void>
  send: () => Promise<void>
  /**
   * Enter edit mode for a previous user message. Backs up any in-flight
   * draft, then seeds the global `input` with the message's text so the
   * inline composer (rendered by `AgentChatPanel`) lights up with the
   * exact same chrome as the bottom one.
   */
  startEditMessage: (messageId: string) => void
  /** Exit edit mode without resending; restores the saved draft. */
  cancelEditMessage: () => void
  /**
   * Truncate the conversation up to the message being edited and submit
   * the current `input` / `attachments` as a fresh turn. Returns when the
   * underlying `send()` resolves.
   */
  submitEditMessage: () => Promise<void>
  deleteMessage: (messageId: string) => void
  /**
   * Rewind ("回收") the turn rooted at `messageId`: pull the user message
   * and every assistant message that follows it (up to but not including
   * the next user message) out of the timeline and into `rewoundTurns`.
   * Used by the per-message ↶ button.
   */
  rewindMessageTurn: (messageId: string) => void
  /** Splice a stashed turn back into the timeline (and remove it from the drawer). */
  restoreRewoundTurn: (turnId: string) => void
  /** Permanently drop every entry in the drawer. */
  clearRewoundTurns: () => void
  /** Restore every stashed turn in one go. */
  restoreAllRewoundTurns: () => void
  cancel: () => Promise<void>
  newThread: () => void
  switchThread: (threadId: string) => Promise<void>
  applyEvent: (event: AgentStreamEvent) => void

  // ----- Sidebar / thread list -----
  sidebarOpen: boolean
  sidebarWidth: number
  threadList: AgentThreadSummary[]
  threadListLoading: boolean
  codexThreadList: CodexThreadSummary[]
  codexThreadListLoading: boolean
  bootstrapped: boolean

  /**
   * Skills available for `$skill-name` invocation. Loaded once on bootstrap
   * via `getSkillsSummary`; consumed by `send()` to attach `skill` input
   * items and by `MentionInput` to drive the `$` trigger popup. Empty array
   * is fine — callers fall back to letting Codex resolve names itself.
   */
  availableSkills: CodexSkillSummary[]
  loadAvailableSkills: () => Promise<void>

  bootstrap: () => Promise<void>
  refreshThreadList: () => Promise<void>
  refreshCodexThreadList: () => Promise<void>
  forkCodexThread: (threadId: string) => Promise<void>
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

function normalizeReferencePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
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
      const steps = sanitizePlanSteps(payload.steps)
      return {
        type: 'activity',
        id: itemId,
        startedAt: now,
        kind: typeof payload.kind === 'string' ? payload.kind : 'activity',
        ...(typeof payload.label === 'string' ? { label: payload.label } : {}),
        ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
        ...(steps != null ? { steps } : {}),
        status: safeStatus,
      }
    }
  }
}

/**
 * Defensive runtime check for `payload.steps`. The patch payload is typed as
 * `Record<string, unknown>` because gateways occasionally rename / reshape
 * the wire format under our feet — without this guard, a bogus value (e.g.
 * `[null, "foo"]`) would land directly on the ActivityItem and crash the
 * PlanCard renderer when it iterates `step.text`.
 */
function sanitizePlanSteps(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: PlanStep[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    if (typeof o.text !== 'string') continue
    const status = o.status
    const validStatus: PlanStep['status'] =
      status === 'completed' || status === 'in_progress' || status === 'pending'
        ? status
        : 'pending'
    out.push({ text: o.text, status: validStatus })
  }
  return out.length > 0 ? out : undefined
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
  if (item.type === 'text') {
    const { content, text, ...metadata } = final
    const finalContent = typeof content === 'string' && content.length > 0
      ? content
      : typeof text === 'string' && text.length > 0
        ? text
        : item.content

    return { ...item, ...metadata, content: finalContent, type: item.type, endedAt: Date.now() }
  }

  return { ...item, ...final, type: item.type, endedAt: Date.now() } as typeof item
}

/**
 * Threshold for the proactive context-window warning. Picked at 0.70 because
 * Codex's own auto-compact triggers at 0.90 (model_auto_compact_token_limit
 * = 0.9 × model_context_window), and the failure mode reported in
 * openai/codex#10823 is that crossing ~0.95 leaves no remaining budget for
 * the model to emit a summary. Catching at 0.70 gives the user (and the
 * agent) breathing room to wrap up the current task, manually compact, or
 * spin up a fresh thread before hitting that wall.
 *
 * Single-tier on purpose: a louder 0.90 banner would duplicate the existing
 * `contextCompaction` ActivityCard (which fires the moment Codex starts
 * compacting), and the donut meter already turns red at ≥0.90.
 */
const CONTEXT_WATERMARK_RATIO_L1 = 0.7

function watermarkKeyL1(threadId: string): string {
  return `${threadId}:l1`
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/**
 * Compute whether the current token usage crosses the level-1 watermark for
 * `threadId`. Returns the notice to push (caller pushes + marks seen), or
 * `null` if no notice should fire right now.
 *
 * Pure: takes everything it needs as arguments so it can be unit-tested
 * without zustand state.
 */
export function deriveContextWatermarkNotice(input: {
  threadId: string | undefined
  usage: AgentTokenUsage
  seen: Record<string, true>
}): AgentNotice | null {
  const { threadId, usage, seen } = input
  if (!threadId) return null
  const used = usage.contextUsage ?? usage.inputTokens + usage.outputTokens
  const window = usage.contextWindow
  if (typeof window !== 'number' || window <= 0) return null
  const ratio = used / window
  if (!Number.isFinite(ratio) || ratio < CONTEXT_WATERMARK_RATIO_L1) return null
  const key = watermarkKeyL1(threadId)
  if (seen[key]) return null
  const pct = Math.min(100, Math.round(ratio * 100))
  return {
    id: `context-watermark:${key}`,
    kind: 'contextHighWatermark',
    level: 'warning',
    threadId,
    message: `上下文已用 ${pct}% (${formatTokensCompact(used)} / ${formatTokensCompact(window)})。Codex 90% 才自动压缩，过高时压缩可能失败（codex#10823）。建议尽快收尾、新开会话或精简上下文。`,
    details: { ratio, used, window, watermark: 'l1' },
  }
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  isOpen: false,
  input: '',
  attachments: [],
  pendingReferences: [],
  pendingApprovals: [],
  notices: [],
  rewoundTurns: [],
  messages: [],
  isRunning: false,
  selectedModelId: readPersistedModelId(),
  selectedVideoModelId: readPersistedVideoModelId(),
  panelWidth: readPersistedPanelWidth(),
  tokenUsage: undefined,
  contextWatermarkSeen: {},
  sidebarOpen: readPersistedSidebarOpen(),
  sidebarWidth: readPersistedSidebarWidth(),
  threadList: [],
  threadListLoading: false,
  codexThreadList: [],
  codexThreadListLoading: false,
  bootstrapped: false,
  availableSkills: [],
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
  appendInputText: (text) => set((state) => ({ input: state.input + text })),
  setError: (error) => set({ error }),
  setSelectedModel: (modelId) => {
    if (!AGENT_MODELS.some((m) => m.id === modelId)) return
    persistModelId(modelId)
    set({ selectedModelId: modelId })
  },
  setSelectedVideoModel: (modelId) => {
    if (!VIDEO_MODELS.some((m) => m.id === modelId)) return
    persistVideoModelId(modelId)
    set({ selectedVideoModelId: modelId })
    // Push to main so the apiyi-mcp child re-spawns with the new GEMINI_MODEL.
    // Fire-and-forget: any failure is non-fatal to the UI; the next save or
    // restart will re-converge from the localStorage value.
    try {
      const bridge = (globalThis as unknown as {
        window?: { electronAPI?: { agent?: { setApiyiVideoModel?: (id: string) => Promise<unknown> } } }
      }).window?.electronAPI?.agent
      void bridge?.setApiyiVideoModel?.(modelId)
    } catch {
      // bridge unavailable in dev/SSR; ignore.
    }
  },
  addAttachment: (attachment) => set((state) => ({ attachments: [...state.attachments, attachment] })),
  removeAttachment: (name) => set((state) => ({
    attachments: state.attachments.filter((item) => item.name !== name),
  })),
  removeAttachmentForReference: (reference) =>
    set((state) => {
      if (reference.source.kind !== 'localPath') {
        return { attachments: state.attachments.filter((item) => item.name !== reference.label) }
      }
      const referencePath = normalizeReferencePath(reference.source.path)
      const index = state.attachments.findIndex((item) => item.path != null && normalizeReferencePath(item.path) === referencePath)
      if (index < 0) return {}
      return { attachments: state.attachments.filter((_, itemIndex) => itemIndex !== index) }
    }),
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
  addApprovalRequest: (request) =>
    set((state) => ({
      pendingApprovals: state.pendingApprovals.some((item) => item.id === request.id)
        ? state.pendingApprovals
        : [...state.pendingApprovals, request],
    })),
  removeApprovalRequest: (id) =>
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((item) => item.id !== id),
    })),
  pushNotice: (notice) =>
    set((state) => {
      // Dedupe by id; keep newest 8 — older ones drop off the bottom.
      const filtered = state.notices.filter((existing) => existing.id !== notice.id)
      return { notices: [notice, ...filtered].slice(0, 8) }
    }),
  dismissNotice: (id) =>
    set((state) => ({
      notices: state.notices.filter((notice) => notice.id !== id),
    })),
  respondToApproval: async (response) => {
    const agent = getAgentApi()
    if (!agent.respondApproval) {
      set({ error: 'Electron approval API is unavailable' })
      return
    }
    try {
      const result = await agent.respondApproval(response)
      if (!result.ok) throw new Error(result.error ?? 'Approval response failed')
      set((state) => ({
        pendingApprovals: state.pendingApprovals.filter((item) => item.id !== response.id),
        error: undefined,
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  send: async () => {
    const state = get()
    const content = state.input.trim()
    const attachments = state.attachments
    const references = state.pendingReferences
    if (state.isRunning) return
    if (!content && attachments.length === 0 && references.length === 0) return

    const modelId = state.selectedModelId
    const now = Date.now()
    const items: TimelineItem[] = []
    if (attachments.length > 0) {
      const refs: AttachmentRef[] = attachments.map((a) => {
        const uri = buildAttachmentUri(a)
        const hasUri = typeof uri === 'string' && uri.length > 0
        // Mirror AgentManager.buildUserTimelineItems on the main side so the
        // image/video classification is consistent across optimistic vs
        // persisted timeline items. We still gate on hasUri so the card
        // renderer never gets an `<img src="">` (which both warns and refetches
        // the page). When the URI is missing we degrade to 'file' so the card
        // renders a 📄 chip instead of a broken `<img>`.
        let kind: AttachmentRef['kind'] = 'file'
        if (hasUri) {
          if (a.mime.startsWith('image/')) kind = 'image'
          else if (a.mime.startsWith('video/')) kind = 'video'
        }
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
      error: undefined,
      isRunning: true,
      messages: [...current.messages, userMsg],
    }))

    // Resolve `$skill-name` markers to {name, path} so codex injects the
    // SKILL.md instructions instead of letting the model resolve names
    // itself. Unresolved tokens (skill cache miss) still travel as text —
    // codex's fallback path will handle them with extra latency.
    const tokens = extractSkillTokens(content)
    const known = new Map(state.availableSkills.map((s) => [s.name, s.path]))
    const skills = Array.from(new Set(tokens))
      .map((name) => {
        const path = known.get(name)
        return path ? { name, path } : null
      })
      .filter((s): s is { name: string; path: string } => s !== null)

    try {
      const result = await getAgentApi().sendMessage({
        threadId: state.threadId,
        content,
        attachments,
        references,
        currentPage: window.location.hash.slice(1),
        model: modelId,
        skills: skills.length > 0 ? skills : undefined,
      })
      set({ threadId: result.threadId })
      // After ingest, replace the optimistic user message's items with the
      // canonical ones from main. The optimistic version uses the raw OS
      // path each attachment was picked from (e.g. `D:\360MoveData\…\foo.png`),
      // which sits OUTSIDE the fs IPC allowed-roots gate — so a click on the
      // attachment chip would silently fail `fs:stat` and never open the
      // file viewer tab. The canonical version uses uploads-cache paths
      // (`<userData>/agent/uploads/<hash>.ext`) which ARE in allowed-roots.
      // Without this patch the user had to refresh the thread before
      // attachments became clickable. Matches Cursor/VSCode's pattern of
      // immediately reflecting server-canonicalized state in the optimistic
      // message — see microsoft/vscode#196782.
      if (result.userMessageItems && result.userMessageItems.length > 0) {
        const canonicalItems = result.userMessageItems
        set((current) => ({
          messages: current.messages.map((m) =>
            m.id === userMsg.id ? { ...m, items: canonicalItems } : m,
          ),
        }))
      }
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
  startEditMessage: (messageId: string) => {
    const state = get()
    if (state.isRunning) return
    if (state.editingMessageId === messageId) return

    const target = state.messages.find((m) => m.id === messageId)
    if (!target) return
    if (target.role !== 'user') return

    const text = target.items
      .filter((item): item is import('../../../../types/agent-timeline').TextItem => item.type === 'text')
      .map((item) => item.content)
      .join('\n')

    set({
      editingMessageId: messageId,
      // Save the bottom composer's draft so cancelling restores it.
      draftBackup: state.editingMessageId
        ? state.draftBackup
        : {
            input: state.input,
            attachments: state.attachments,
            pendingReferences: state.pendingReferences,
          },
      input: text,
      // Attachments aren't rehydratable from AttachmentRef (uri may be a
      // revoked blob), so we start with a clean slate. The user can drag
      // files back in if needed — mirrors Cursor's behaviour.
      attachments: [],
      pendingReferences: [],
      error: undefined,
    })
  },
  cancelEditMessage: () => {
    const state = get()
    if (!state.editingMessageId) return
    const backup = state.draftBackup
    set({
      editingMessageId: undefined,
      draftBackup: undefined,
      input: backup?.input ?? '',
      attachments: backup?.attachments ?? [],
      pendingReferences: backup?.pendingReferences ?? [],
    })
  },
  submitEditMessage: async () => {
    const state = get()
    const editingId = state.editingMessageId
    if (!editingId || state.isRunning) return

    const idx = state.messages.findIndex((m) => m.id === editingId)
    if (idx === -1) {
      // Stale edit target — bail out cleanly.
      set({ editingMessageId: undefined, draftBackup: undefined })
      return
    }

    set({
      messages: state.messages.slice(0, idx),
      editingMessageId: undefined,
      draftBackup: undefined,
    })

    await get().send()
  },
  deleteMessage: (messageId: string) => {
    set((current) => ({
      messages: current.messages.filter((m) => m.id !== messageId),
    }))
  },
  rewindMessageTurn: (messageId: string) => {
    const state = get()
    const startIdx = state.messages.findIndex((m) => m.id === messageId)
    if (startIdx === -1) return
    const target = state.messages[startIdx]
    if (target.role !== 'user') return

    // Walk forward until the next user message: that whole slice is "this round".
    let endIdx = state.messages.length
    for (let i = startIdx + 1; i < state.messages.length; i += 1) {
      if (state.messages[i].role === 'user') {
        endIdx = i
        break
      }
    }
    const slice = state.messages.slice(startIdx, endIdx)
    if (slice.length === 0) return

    // First non-empty text content for the drawer preview. We strip newlines
    // so the row stays single-line even if the message was multi-line.
    const previewSource = slice[0].items
      .filter(
        (item): item is import('../../../../types/agent-timeline').TextItem =>
          item.type === 'text',
      )
      .map((item) => item.content)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const preview = previewSource.length > 0 ? previewSource : '(empty message)'

    const turn: RewoundTurn = {
      id: createId(),
      rewoundAt: Date.now(),
      originalIndex: startIdx,
      messages: slice,
      preview,
    }

    set((current) => ({
      messages: [...current.messages.slice(0, startIdx), ...current.messages.slice(endIdx)],
      rewoundTurns: [turn, ...current.rewoundTurns],
      // If the user was editing a message inside the rewound slice, drop
      // the edit state so the bottom composer reappears cleanly.
      ...(current.editingMessageId &&
      slice.some((m) => m.id === current.editingMessageId)
        ? { editingMessageId: undefined, draftBackup: undefined }
        : {}),
    }))
  },
  restoreRewoundTurn: (turnId: string) => {
    const state = get()
    const turn = state.rewoundTurns.find((t) => t.id === turnId)
    if (!turn) return
    // Clamp so we never splice past the end after other actions reshaped
    // the timeline (deletes, more rewinds, new turns, etc.).
    const insertAt = Math.min(turn.originalIndex, state.messages.length)
    set({
      messages: [
        ...state.messages.slice(0, insertAt),
        ...turn.messages,
        ...state.messages.slice(insertAt),
      ],
      rewoundTurns: state.rewoundTurns.filter((t) => t.id !== turnId),
    })
  },
  clearRewoundTurns: () => set({ rewoundTurns: [] }),
  restoreAllRewoundTurns: () => {
    const state = get()
    if (state.rewoundTurns.length === 0) return
    // Restore in chronological order (oldest first) so each splice's
    // originalIndex still makes sense relative to a growing timeline.
    const ordered = [...state.rewoundTurns].sort((a, b) => a.rewoundAt - b.rewoundAt)
    let messages = state.messages
    for (const turn of ordered) {
      const insertAt = Math.min(turn.originalIndex, messages.length)
      messages = [...messages.slice(0, insertAt), ...turn.messages, ...messages.slice(insertAt)]
    }
    set({ messages, rewoundTurns: [] })
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
      // Fresh session => fresh watermark dedup. Cross-thread entries are
      // already isolated by threadId-keyed keys, but resetting on newThread
      // is the right place to release the bookkeeping for a clean slate.
      contextWatermarkSeen: {},
      pendingApprovals: [],
      rewoundTurns: [],
      editingMessageId: undefined,
      draftBackup: undefined,
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
      pendingApprovals: [],
    })
  },
  applyEvent: (event) => {
    // Two new global events bypass the thread guard: `skills_changed` is
    // workspace-wide, and `notice` may or may not have a threadId. The
    // existing `mcp_*` events already lack threadId and rely on the same
    // bypass-by-shape: the guard only fires when a threadId is present.
    if (event.type === 'skills_changed') {
      void get().loadAvailableSkills()
      return
    }
    if (event.type === 'notice') {
      const activeThreadId = get().threadId
      if (event.notice.threadId && activeThreadId && event.notice.threadId !== activeThreadId) return
      get().pushNotice(event.notice)
      return
    }

    const activeThreadId = get().threadId
    if (
      activeThreadId &&
      'threadId' in event &&
      typeof event.threadId === 'string' &&
      event.threadId !== activeThreadId
    )
      return

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
            () => applyItemPatch(createItemFromStarted(event.itemType, itemId, {}), event.patch),
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
            () => applyItemCompleted(createItemFromStarted(event.itemType, itemId, {}), event.final),
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
      case 'token_usage_updated': {
        // Just overwrite — Codex sends cumulative counts. The header meter
        // reads `tokenUsage.contextUsage / contextWindow` if both are
        // present, otherwise falls back to inputTokens+outputTokens.
        set({ tokenUsage: event.usage })
        // Proactive 70% watermark check. See `deriveContextWatermarkNotice`
        // for the rationale; in short, Codex's 90% auto-compact can run out
        // of summary budget on very long sessions (openai/codex#10823), so
        // we surface a warning early enough for the user to course-correct.
        const state = get()
        const notice = deriveContextWatermarkNotice({
          threadId: state.threadId,
          usage: event.usage,
          seen: state.contextWatermarkSeen,
        })
        if (notice && state.threadId) {
          const key = watermarkKeyL1(state.threadId)
          set({ contextWatermarkSeen: { ...state.contextWatermarkSeen, [key]: true } })
          state.pushNotice(notice)
        }
        break
      }
      case 'error':
        set({ error: event.error, isRunning: false })
        break
      case 'cancelled':
        set({ isRunning: false })
        break
      case 'attachment_error': {
        // Per-attachment ingest failures are non-fatal — surface them as a
        // notice so the user sees which file was skipped and why, without
        // killing the turn that succeeded for the other attachments.
        const state = get()
        state.pushNotice({
          id: `attachment-${event.name}-${Date.now()}`,
          kind: 'attachmentSkipped',
          level: 'warning',
          message: `已跳过 ${event.name}：${event.error}`,
          threadId: event.threadId,
        })
        break
      }
      case 'mcp_status_updated':
      case 'mcp_oauth_completed':
        // MCP lifecycle pulses are subscribed to via a dedicated `agent:mcp-*`
        // IPC channel in MCPSection — no-op here so the exhaustive guard
        // below stays happy.
        break
      default: {
        // exhaustiveness: every AgentStreamEvent variant must be handled above.
        const _exhaustive: never = event
        void _exhaustive
        break
      }
    }
  },

  loadAvailableSkills: async () => {
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.getSkillsSummary) return
    try {
      const summary = await agent.getSkillsSummary()
      set({ availableSkills: summary.skills })
    } catch {
      // Skills are an optional convenience — keep the previous cache rather
      // than burning a banner on the chat panel for a transient IPC failure.
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
      void get().refreshCodexThreadList()
      void get().loadAvailableSkills()
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

  refreshCodexThreadList: async () => {
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.listCodexThreads) {
      set({ codexThreadList: [], codexThreadListLoading: false })
      return
    }
    set({ codexThreadListLoading: true })
    try {
      const list = await agent.listCodexThreads()
      set({ codexThreadList: list })
    } catch {
      set({ codexThreadList: [] })
    } finally {
      set({ codexThreadListLoading: false })
    }
  },

  forkCodexThread: async (threadId) => {
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.forkCodexThread) {
      set({ error: 'Electron Codex thread fork API is unavailable' })
      return
    }
    try {
      await agent.forkCodexThread(threadId)
      await get().refreshCodexThreadList()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
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
      set({
        threadId: undefined,
        messages: [],
        tokenUsage: undefined,
        error: undefined,
        isRunning: false,
        pendingApprovals: [],
      })
    }
    await get().refreshThreadList()
  },
}))

export type { AgentChatState }
export type { AgentChatMessage } from './types'
