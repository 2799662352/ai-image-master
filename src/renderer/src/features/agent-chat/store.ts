import { create } from 'zustand'
import {
  loadChatScrollByThread,
  persistChatScrollByThread,
  type ChatScrollByThread,
  type ChatScrollState,
} from './chatScroll'
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
import type { GoalRpcResult, ThreadGoal, ThreadGoalStatus } from '../../../../types/codexGoals'
import type { AgentReference } from '../../../../types/agent-reference'
import type { ArtifactItem, ArtifactSaveInfo, AttachmentRef, ChoiceAnswer, ChoiceOption, ChoiceRequestItem, Message, PlanStep, TimelineItem } from '../../../../types/agent-timeline'
import {
  dropSupersededStreamItemsInLastMessage,
  trimRetriedStreamItemsInLastMessage,
  upsertItemInLastMessage,
} from '../../../../types/agent-timeline'
import { AGENT_MODELS, DEFAULT_MODEL_ID } from './models'
import { contextUsedPercent } from './contextWindowDefaults'
import { DEFAULT_IMAGE_CHANNEL_ID, isSelectableImageChannel } from './imageChannels'
import { useFileExplorerStore } from '../file-explorer/store'
import { rehydrateCodexArtifacts } from './codexArtifactPersistence'

const SELECTED_MODEL_STORAGE_KEY = 'catimation.agent.selectedModel'
const SELECTED_IMAGE_CHANNEL_STORAGE_KEY = 'catimation.agent.selectedImageChannel'
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

function readPersistedImageChannel(): string {
  try {
    const raw = globalThis.localStorage?.getItem(SELECTED_IMAGE_CHANNEL_STORAGE_KEY)
    if (!raw) return DEFAULT_IMAGE_CHANNEL_ID
    return isSelectableImageChannel(raw) ? raw : DEFAULT_IMAGE_CHANNEL_ID
  } catch {
    return DEFAULT_IMAGE_CHANNEL_ID
  }
}

function persistImageChannel(id: string): void {
  try {
    globalThis.localStorage?.setItem(SELECTED_IMAGE_CHANNEL_STORAGE_KEY, id)
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
    steer?: (payload: AgentSendMessagePayload) => Promise<AgentSendMessageResult>
    cancel: (payload: AgentCancelPayload) => Promise<unknown>
    listThreads?: () => Promise<AgentThreadSummary[]>
    openThread?: (id: string) => Promise<unknown>
    renameThread?: (id: string, title: string) => Promise<void>
    deleteThread?: (id: string) => Promise<void>
    respondApproval?: (response: CodexApprovalResponse) => Promise<AgentApiResult>
    listCodexThreads?: () => Promise<CodexThreadSummary[]>
    forkCodexThread?: (threadId: string) => Promise<CodexThreadSummary>
    getSkillsSummary?: () => Promise<CodexSkillsSummary>
    // Codex native `/goal` (thread/goal/*). threadId = DB thread id.
    setGoal?: (
      threadId: string,
      params: { objective?: string; tokenBudget?: number; status?: ThreadGoalStatus },
    ) => Promise<GoalRpcResult<ThreadGoal>>
    getGoal?: (threadId: string) => Promise<GoalRpcResult<ThreadGoal | null>>
    clearGoal?: (threadId: string) => Promise<GoalRpcResult<{ cleared: boolean }>>
    // Codex native `/compact` (thread/compact/start). threadId = DB thread id.
    compactThread?: (threadId: string) => Promise<GoalRpcResult<{ started: boolean }>>
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
  /**
   * One-shot context note injected into the NEXT user turn after the user
   * manually opens the canvas (chat 画布 button). Lets Codex know the canvas is
   * now the active surface so follow-ups are smooth — it won't claim it can't
   * see the canvas and will reach for canvas_snapshot/edit tools. Cleared after
   * it rides one message. Not set when Codex opens the canvas itself (canvas_open).
   */
  pendingCanvasContext: string | null
  pendingApprovals: CodexApprovalRequest[]
  /**
   * Transient notices surfaced from codex `app-server` notifications:
   * configWarning, deprecationNotice, model rerouting, hook lifecycle, and
   * auto-approval review pulses. Newest first. UI renders dismissible
   * banners; warnings stick around, info notices auto-fade.
   */
  notices: AgentNotice[]
  /**
   * Native `/goal` state per DB thread. `null` = fetched, no goal set;
   * `undefined` (absent key) = not fetched yet. Updated live by the
   * `thread/goal/updated|cleared` notification stream and by explicit reads.
   */
  goalByThread: Record<string, ThreadGoal | null>
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
  /** User-selected image render channel (authoritative for generate_image). */
  selectedImageChannel: string
  messages: Message[]
  /**
   * Background per-thread streaming state for chats that are NOT the active
   * view. Populated when you switch away from / start a new chat while a turn
   * is still running, and kept current by `applyEvent` routing background
   * events here. Restored into the active view on `switchThread`. Keyed by
   * db threadId. The active thread is intentionally absent (its state lives in
   * the top-level fields).
   */
  threadSlices: Record<string, ThreadSlice>
  /**
   * Per-thread "is a turn running" flags, for the whole panel (active +
   * background). Drives the ThreadSidebar running dots and lets the user see
   * which chats are still working. Source of truth for cross-thread running.
   */
  runningByThread: Record<string, boolean>
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
  setSelectedImageChannel: (channelId: string) => void
  addAttachment: (attachment: AgentAttachmentInput) => void
  removeAttachment: (name: string) => void
  removeAttachmentForReference: (reference: AgentReference) => void
  addPendingReference: (reference: AgentReference) => void
  removePendingReference: (referenceId: string) => void
  clearPendingReferences: () => void
  /** Mark that the user just opened the canvas; rides the next turn as context. */
  notifyCanvasOpened: () => void
  addApprovalRequest: (request: CodexApprovalRequest) => void
  removeApprovalRequest: (id: string) => void
  pushNotice: (notice: AgentNotice) => void
  dismissNotice: (id: string) => void
  respondToApproval: (response: CodexApprovalResponse) => Promise<void>
  /** Apply a `goal_updated`/`goal_cleared` stream event to `goalByThread`. */
  applyGoalEvent: (event: AgentStreamEvent) => void
  /** Fetch the current goal for a thread (defaults to active) into state. */
  refreshGoal: (threadId?: string) => Promise<void>
  /** Set/replace the active thread's goal objective (optional token budget). */
  setGoal: (objective: string, tokenBudget?: number) => Promise<void>
  /** Change the active thread's goal status (pause/resume/blocked). */
  setGoalStatus: (status: ThreadGoalStatus) => Promise<void>
  /** Set/replace only the token budget on the existing goal. */
  setGoalBudget: (tokenBudget: number) => Promise<void>
  /** Clear the active thread's goal. */
  clearGoal: () => Promise<void>
  /** Kick off real native history compaction (thread/compact/start). */
  compact: () => Promise<void>
  send: () => Promise<void>
  /**
   * Append the composer input to the CURRENTLY RUNNING turn (Codex
   * `turn/steer`) instead of starting a new one — the app's "运行中插话".
   * No-op unless a turn is running on the active thread. The steered output
   * arrives on the same turn's existing event stream.
   */
  steer: () => Promise<void>
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
  /**
   * Append a standalone assistant message whose sole content is an
   * `ArtifactItem` (generated images). Used by the codex `generate_image`
   * tool path so the result shows up as its own bubble (thumbnail +
   * click-to-fullscreen via ArtifactCard), separate from any in-flight
   * assistant text. No-op when `artifacts` is empty.
   */
  appendArtifactMessage: (artifacts: AttachmentRef[], threadId?: string) => void

  /**
   * Image-generation status machine for the codex `generate_image` tool.
   * `beginImageGeneration` appends a standalone assistant bubble in the
   * `generating` state (spinner + prompt) and returns its artifact-item id.
   * The caller then resolves it with the finished images, or fails it with an
   * error message — both edit the SAME bubble in place (no flicker / no extra
   * messages). Returns the item id used by resolve/fail.
   *
   * `threadId` pins the bubble to the chat that REQUESTED the generation so a
   * background turn's image never lands in whatever chat happens to be active
   * when it finishes (parallel-chat contamination). Omit for the active view.
   */
  beginImageGeneration: (prompt: string, threadId?: string, mediaKind?: 'image' | 'video') => string
  resolveImageGeneration: (itemId: string, artifacts: AttachmentRef[], threadId?: string) => void
  failImageGeneration: (itemId: string, error: string, threadId?: string) => void

  /**
   * Update the live progress line on a `generating` bubble (video tasks:
   * "排队中…" → "生成中 · 23s"). Edits the SAME bubble in place; no-op once
   * the item has settled to done/error.
   */
  updateGenerationProgress: (itemId: string, progressText: string, threadId?: string) => void

  /**
   * Attach/refresh the save-status banner on a generation bubble. Called after
   * `resolveImageGeneration`: first with `pending` when persistence exceeds its
   * time budget, then again with `saved`/`failed` when the background save
   * settles — the SAME bubble updates in place.
   */
  annotateImageGeneration: (itemId: string, save: ArtifactSaveInfo, threadId?: string) => void

  /**
   * Swap a settled generation bubble's artifacts in place — used after
   * persistence lands the image on disk/COS so the bubble can drop the inline
   * multi-MB `data:` base64 (which otherwise lingers in the store for the whole
   * session) and point at a lightweight local path / COS URL instead. Keeps
   * `status` and the `save` banner untouched; no-op on unknown id.
   */
  replaceImageArtifacts: (itemId: string, artifacts: AttachmentRef[], threadId?: string) => void

  /**
   * Interactive `ask_user` flow. `ask` appends a standalone assistant bubble
   * holding a single `choiceRequest` item (rendered by AskUserCard) and returns
   * a Promise that resolves once the user answers/skips — the renderer-routed
   * `ask_user` tool awaits this so the agent blocks on real user input.
   * `settleChoiceRequest` is called by the card on click: it marks the item
   * answered in place and resolves the pending Promise.
   *
   * `threadId` pins the card to the requesting chat (parallel-chat safety).
   */
  ask: (
    request: {
      question: string
      options: ChoiceOption[]
      mode: 'single' | 'multi'
      allowFreeText: boolean
      allowSkip: boolean
    },
    threadId?: string,
  ) => Promise<ChoiceAnswer>
  settleChoiceRequest: (requestId: string, answer: ChoiceAnswer) => void

  // ----- Per-thread chat scroll state -----
  /**
   * Persisted per-thread scroll position + lock-to-bottom flag.
   *   - Restored on panel reopen, thread switch, and app restart (localStorage).
   *   - Lock flips back to true on `sendMessage` (user just submitted, they
   *     want to see the reply tail).
   *   - Lock flips to false when user scrolls past 48 px above the bottom,
   *     and back to true when they return into the threshold zone.
   *   - Pure-function helpers + tests live in `./chatScroll.ts`.
   */
  chatScrollByThread: ChatScrollByThread
  setChatScroll: (threadId: string, partial: Partial<ChatScrollState>) => void
  lockChatScrollToBottom: (threadId: string) => void

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

/** Coerce a server `createdAt` (epoch number | ISO string | Date) to epoch ms. */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : undefined
  }
  return undefined
}

/**
 * Pending `ask_user` resolvers, keyed by `requestId`. Resolver functions are
 * NOT serializable, so they live module-scoped rather than in zustand state;
 * `ask()` stores one, `settleChoiceRequest()` pops + calls it. The matching
 * `choiceRequest` timeline item (which IS serializable) carries the requestId
 * so the rendered card can settle the right pending call.
 */
const choiceResolvers = new Map<string, (answer: ChoiceAnswer) => void>()

/**
 * Answer used when a pending `ask_user` card is torn down (its turn is
 * cancelled or its thread deleted) before the user clicked: report it as a
 * clean "skipped" so the agent's blocked call returns instead of hanging.
 */
const ABANDONED_CHOICE_ANSWER: ChoiceAnswer = { answered: false, skipped: true, selected: [] }

/**
 * Immutably mark the `choiceRequest` item with `requestId` answered wherever it
 * lives. Only matches a still-`pending` card, so a stray double-settle (or a
 * settle on an already-expired card) is a no-op. Returns the same array
 * reference when nothing matched.
 */
function mapChoiceItem(
  messages: Message[],
  requestId: string,
  update: (item: ChoiceRequestItem) => ChoiceRequestItem,
): Message[] {
  let changed = false
  const next = messages.map((message) => {
    let itemChanged = false
    const items = message.items.map((item) => {
      if (item.type === 'choiceRequest' && item.requestId === requestId && item.status === 'pending') {
        itemChanged = true
        return update(item)
      }
      return item
    })
    if (!itemChanged) return message
    changed = true
    return { ...message, items }
  })
  return changed ? next : messages
}

/**
 * Freeze every still-`pending` choiceRequest in `messages` (mark it answered as
 * abandoned) and collect their requestIds so the caller can resolve the matching
 * blocked `ask()` promises AFTER the `set()` commits. Pure: returns the same
 * array reference when nothing was pending. Used by `cancel`/`deleteThread` so a
 * dangling ask_user card never blocks the agent or stays clickable-but-dead.
 */
function expirePendingChoices(messages: Message[]): { messages: Message[]; ids: string[] } {
  const ids: string[] = []
  let changed = false
  const next = messages.map((message) => {
    let itemChanged = false
    const items = message.items.map((item) => {
      if (item.type === 'choiceRequest' && item.status === 'pending') {
        itemChanged = true
        ids.push(item.requestId)
        return { ...item, status: 'answered' as const, answer: ABANDONED_CHOICE_ANSWER, endedAt: Date.now() }
      }
      return item
    })
    if (!itemChanged) return message
    changed = true
    return { ...message, items }
  })
  return { messages: changed ? next : messages, ids }
}

/** Resolve + drop the blocked `ask()` promises for the given requestIds. */
function resolveAbandonedChoices(ids: string[]): void {
  for (const id of ids) {
    const resolve = choiceResolvers.get(id)
    if (resolve) {
      choiceResolvers.delete(id)
      resolve(ABANDONED_CHOICE_ANSWER)
    }
  }
}

/**
 * Immutably update the artifact `TimelineItem` with `itemId` wherever it lives
 * in the message list. Returns the same array reference when nothing matched
 * so zustand can skip a redundant notification.
 */
function mapArtifactItem(
  messages: Message[],
  itemId: string,
  update: (item: ArtifactItem) => ArtifactItem,
): Message[] {
  let changed = false
  const next = messages.map((message) => {
    let itemChanged = false
    const items = message.items.map((item) => {
      if (item.type === 'artifact' && item.id === itemId) {
        itemChanged = true
        return update(item)
      }
      return item
    })
    if (!itemChanged) return message
    changed = true
    return { ...message, items }
  })
  return changed ? next : messages
}

/**
 * Apply a messages updater to a SPECIFIC thread — the active view when
 * `threadId` is the active thread (or omitted), otherwise that thread's
 * background slice. This is what keeps image-generation bubbles
 * (begin/resolve/fail), which run outside the per-event `applyEvent` routing,
 * pinned to the chat that requested them even after the user switches away or
 * starts a new chat. Returns a `set()` patch (empty object = no change).
 */
function patchThreadMessages(
  s: { threadId?: string; messages: Message[]; threadSlices: Record<string, ThreadSlice> },
  threadId: string | undefined,
  updater: (msgs: Message[]) => Message[],
): { messages?: Message[]; threadSlices?: Record<string, ThreadSlice> } {
  const target = threadId ?? s.threadId
  if (target == null || target === s.threadId) {
    const next = updater(s.messages)
    return next === s.messages ? {} : { messages: next }
  }
  const slice = s.threadSlices[target] ?? EMPTY_THREAD_SLICE
  const next = updater(slice.messages)
  if (next === slice.messages) return {}
  return { threadSlices: { ...s.threadSlices, [target]: { ...slice, messages: next } } }
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

function localPathFromAttachmentUri(uri: string): string | undefined {
  if (typeof uri !== 'string' || uri.length === 0) return undefined
  const prefix = 'local-file:///'
  if (uri.toLowerCase().startsWith(prefix)) {
    try {
      const decoded = decodeURIComponent(uri.slice(prefix.length))
      if (decoded.split(/[\\/]/).some((segment) => segment === '..')) return undefined
      if (/^[A-Za-z]:[\\/]/.test(decoded)) return decoded
      return decoded.startsWith('/') ? decoded : `/${decoded}`
    } catch {
      return undefined
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(uri) || uri.startsWith('/')) return uri
  return undefined
}

function attachmentsFromMessage(message: Message): AgentAttachmentInput[] {
  const out: AgentAttachmentInput[] = []
  for (const item of message.items) {
    if (item.type !== 'attachment') continue
    for (const ref of item.attachments) {
      const path = localPathFromAttachmentUri(ref.uri)
      if (!path) continue
      out.push({
        name: ref.name,
        mime: ref.mime || 'application/octet-stream',
        size: typeof ref.size === 'number' ? ref.size : 0,
        path,
      })
    }
  }
  return out
}

function getAgentApi(): NonNullable<AgentElectronApi['agent']> {
  const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
  if (!agent) throw new Error('Electron agent API is unavailable')
  return agent
}

function formatGoalTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

function formatGoalDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0m'
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ''}`
  if (m > 0) return `${m}m`
  return `${Math.floor(totalSeconds)}s`
}

/**
 * Build a user-facing notice when the autonomous goal loop transitions into an
 * attention state. Returns null for statuses that need no alert (active/paused).
 * `complete` doubles as the completion report (final token + time usage).
 */
function goalTransitionNotice(threadId: string, goal: ThreadGoal): AgentNotice | null {
  const id = `goal-status:${threadId}:${goal.status}:${goal.updatedAt}`
  switch (goal.status) {
    case 'blocked':
      return { id, kind: 'configWarning', level: 'warning', threadId, message: '目标受阻,需要你介入 —— 处理后用 /goal resume 继续。' }
    case 'budgetLimited':
      return { id, kind: 'configWarning', level: 'warning', threadId, message: '目标预算耗尽 —— 用 /goal budget <n> 提高预算后 /goal resume 继续。' }
    case 'usageLimited':
      return { id, kind: 'configWarning', level: 'warning', threadId, message: '用量受限,目标已暂停 —— 稍后用 /goal resume 重试。' }
    case 'complete':
      return {
        id,
        kind: 'configWarning',
        level: 'info',
        threadId,
        message: `🎉 目标已完成 —— 用量 ${formatGoalTokens(goal.tokensUsed)} tok · 用时 ${formatGoalDuration(goal.timeUsedSeconds)}。`,
      }
    default:
      return null
  }
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
    case 'choiceRequest':
      // choiceRequest items are created locally via ask(), never from an
      // agent "started" event. Reaching here means the backend emitted an
      // unexpected item type.
      throw new Error('choiceRequest items are created via ask(), not agent-started events')
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
 * The per-thread streaming state that must stay isolated so multiple chats can
 * run concurrently. The store keeps ONE of these "live" as the active view
 * (mirrored onto the top-level `messages`/`isRunning`/`tokenUsage`/`error`
 * fields for zero-churn UI reads) and a `threadSlices` map for every OTHER
 * thread whose turn is still streaming in the background. Switching threads is
 * a snapshot(active → map) + restore(map → active); it never cancels the
 * backend turn (the main process + CodexProtocolClient are already per-(thread,
 * turn) safe), so leaving a chat no longer drops its in-flight output.
 */
export interface ThreadSlice {
  messages: Message[]
  isRunning: boolean
  tokenUsage?: AgentTokenUsage
  error?: string
}

const EMPTY_THREAD_SLICE: ThreadSlice = {
  messages: [],
  isRunning: false,
  tokenUsage: undefined,
  error: undefined,
}

/**
 * Pure per-thread reducer for a streaming `AgentStreamEvent`. Mirrors the
 * timeline-mutating cases of `applyEvent` but operates on an isolated
 * `ThreadSlice` so it can drive BOTH the active view and any number of
 * background threads. Side effects (notices, thread-list refresh, the context
 * watermark) deliberately stay in `applyEvent` — this function is referentially
 * transparent and unit-testable. Events that don't touch the timeline
 * (`thread_created`, `attachment_error`, `mcp_*`, etc.) return the slice
 * unchanged.
 */
export function reduceThreadSlice(slice: ThreadSlice, event: AgentStreamEvent): ThreadSlice {
  switch (event.type) {
    case 'item_started': {
      const itemId = resolveItemId(event)
      const msgs = ensureAssistantMessage(slice.messages)
      const next = upsertItemInLastMessage(
        msgs,
        itemId,
        () => createItemFromStarted(event.itemType, itemId, event.payload),
        (item) => item,
      )
      return next === slice.messages ? slice : { ...slice, messages: next }
    }
    case 'item_delta': {
      const itemId = resolveItemId(event)
      const msgs = ensureAssistantMessage(slice.messages)
      let next = upsertItemInLastMessage(
        msgs,
        itemId,
        () => applyItemPatch(createItemFromStarted(event.itemType, itemId, {}), event.patch),
        (item) => applyItemPatch(item, event.patch),
      )
      // Cumulative-snapshot gateways re-send the FULL text under a NEW item
      // id per chunk; collapse superseded snapshots so the bubble shows one
      // growing paragraph instead of stacking duplicates ("对话重复").
      if (event.itemType === 'text' || event.itemType === 'reasoning') {
        next = dropSupersededStreamItemsInLastMessage(next, itemId)
      }
      return next === slice.messages ? slice : { ...slice, messages: next }
    }
    case 'item_completed': {
      const itemId = resolveItemId(event)
      const msgs = ensureAssistantMessage(slice.messages)
      let next = upsertItemInLastMessage(
        msgs,
        itemId,
        () => applyItemCompleted(createItemFromStarted(event.itemType, itemId, {}), event.final),
        (item) => applyItemCompleted(item, event.final),
      )
      if (event.itemType === 'text' || event.itemType === 'reasoning') {
        next = dropSupersededStreamItemsInLastMessage(next, itemId)
      }
      return next === slice.messages ? slice : { ...slice, messages: next }
    }
    case 'turn_completed':
      return { ...slice, isRunning: false }
    case 'token_usage_updated':
      return { ...slice, tokenUsage: event.usage }
    case 'error': {
      if (event.willRetry) {
        // Transient stream error: codex will retry the SAME request and
        // re-stream the full response under NEW item ids. Drop the failed
        // attempt's trailing partial text/reasoning so the retry replaces it
        // instead of stacking a duplicate paragraph, and keep the turn
        // running — this is not a terminal error (openai/codex#7611).
        const msgs = trimRetriedStreamItemsInLastMessage(slice.messages)
        return msgs === slice.messages ? slice : { ...slice, messages: msgs }
      }
      return { ...slice, error: event.error, isRunning: false }
    }
    case 'cancelled':
      return { ...slice, isRunning: false }
    default:
      return slice
  }
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
  // Codex-aligned occupancy: percent of the EFFECTIVE window (minus the 12K
  // baseline), matching the header donut and the TUI. This is what the user
  // sees on the meter, so the watermark must fire on the same number — not the
  // raw used/window ratio. See contextWindowDefaults.contextUsedPercent().
  const pctExact = contextUsedPercent(used, window)
  if (pctExact == null) return null
  const ratio = pctExact / 100
  if (!Number.isFinite(ratio) || ratio < CONTEXT_WATERMARK_RATIO_L1) return null
  const key = watermarkKeyL1(threadId)
  if (seen[key]) return null
  const pct = Math.min(100, Math.round(pctExact))
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
  pendingCanvasContext: null,
  pendingApprovals: [],
  notices: [],
  goalByThread: {},
  rewoundTurns: [],
  messages: [],
  isRunning: false,
  threadSlices: {},
  runningByThread: {},
  chatScrollByThread: loadChatScrollByThread(),
  selectedModelId: readPersistedModelId(),
  selectedImageChannel: readPersistedImageChannel(),
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
  appendArtifactMessage: (artifacts, threadId) =>
    set((s) => {
      if (!artifacts || artifacts.length === 0) return {}
      const now = Date.now()
      const item: TimelineItem = { type: 'artifact', id: createId(), startedAt: now, endedAt: now, artifacts, status: 'done' }
      const message: Message = { id: createId(), role: 'assistant', createdAt: now, items: [item] }
      return patchThreadMessages(s, threadId, (msgs) => [...msgs, message])
    }),
  beginImageGeneration: (prompt, threadId, mediaKind) => {
    const itemId = createId()
    set((s) => {
      const now = Date.now()
      const item: TimelineItem = {
        type: 'artifact',
        id: itemId,
        startedAt: now,
        artifacts: [],
        status: 'generating',
        prompt,
        ...(mediaKind ? { mediaKind } : {}),
      }
      const message: Message = { id: createId(), role: 'assistant', createdAt: now, items: [item] }
      return patchThreadMessages(s, threadId, (msgs) => [...msgs, message])
    })
    return itemId
  },
  resolveImageGeneration: (itemId, artifacts, threadId) =>
    set((s) =>
      patchThreadMessages(s, threadId, (msgs) =>
        mapArtifactItem(msgs, itemId, (item) => ({
          ...item,
          artifacts,
          status: 'done',
          endedAt: Date.now(),
        })),
      ),
    ),
  failImageGeneration: (itemId, error, threadId) =>
    set((s) =>
      patchThreadMessages(s, threadId, (msgs) =>
        mapArtifactItem(msgs, itemId, (item) => ({
          ...item,
          status: 'error',
          error,
          endedAt: Date.now(),
        })),
      ),
    ),
  updateGenerationProgress: (itemId, progressText, threadId) =>
    set((s) =>
      patchThreadMessages(s, threadId, (msgs) =>
        mapArtifactItem(msgs, itemId, (item) =>
          item.status === 'generating' ? { ...item, progressText } : item,
        ),
      ),
    ),
  annotateImageGeneration: (itemId, save, threadId) =>
    set((s) =>
      patchThreadMessages(s, threadId, (msgs) =>
        mapArtifactItem(msgs, itemId, (item) => ({
          ...item,
          save,
        })),
      ),
    ),
  replaceImageArtifacts: (itemId, artifacts, threadId) =>
    set((s) =>
      patchThreadMessages(s, threadId, (msgs) =>
        mapArtifactItem(msgs, itemId, (item) => ({
          ...item,
          artifacts,
        })),
      ),
    ),
  ask: (request, threadId) => {
    const requestId = createId()
    set((s) => {
      const now = Date.now()
      const item: TimelineItem = {
        type: 'choiceRequest',
        id: createId(),
        startedAt: now,
        requestId,
        question: request.question,
        options: request.options,
        mode: request.mode,
        allowFreeText: request.allowFreeText,
        allowSkip: request.allowSkip,
        status: 'pending',
      }
      const message: Message = { id: createId(), role: 'assistant', createdAt: now, items: [item] }
      return patchThreadMessages(s, threadId, (msgs) => [...msgs, message])
    })
    return new Promise<ChoiceAnswer>((resolve) => {
      choiceResolvers.set(requestId, resolve)
    })
  },
  settleChoiceRequest: (requestId, answer) => {
    set((s) => {
      // Search the active view AND every background thread slice — the card may
      // belong to a chat the user has since switched away from.
      const inActive = mapChoiceItem(s.messages, requestId, (item) => ({
        ...item,
        status: 'answered',
        answer,
        endedAt: Date.now(),
      }))
      if (inActive !== s.messages) return { messages: inActive }
      let touched = false
      const slices: Record<string, ThreadSlice> = {}
      for (const [tid, slice] of Object.entries(s.threadSlices)) {
        const next = mapChoiceItem(slice.messages, requestId, (item) => ({
          ...item,
          status: 'answered',
          answer,
          endedAt: Date.now(),
        }))
        if (next !== slice.messages) {
          touched = true
          slices[tid] = { ...slice, messages: next }
        } else {
          slices[tid] = slice
        }
      }
      return touched ? { threadSlices: slices } : {}
    })
    const resolve = choiceResolvers.get(requestId)
    if (resolve) {
      choiceResolvers.delete(requestId)
      resolve(answer)
    }
  },
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
  setChatScroll: (threadId, partial) =>
    set((state) => {
      const prev = state.chatScrollByThread[threadId] ?? { scrollTop: 0, followBottom: true }
      const next = { ...prev, ...partial }
      // Bail when nothing actually changed — avoids redundant zustand
      // notifications during noisy onScroll bursts.
      if (next.scrollTop === prev.scrollTop && next.followBottom === prev.followBottom) {
        return state
      }
      const merged: ChatScrollByThread = { ...state.chatScrollByThread, [threadId]: next }
      persistChatScrollByThread(merged)
      return { chatScrollByThread: merged }
    }),
  lockChatScrollToBottom: (threadId) =>
    set((state) => {
      const prev = state.chatScrollByThread[threadId] ?? { scrollTop: 0, followBottom: true }
      if (prev.followBottom) return state
      const merged: ChatScrollByThread = {
        ...state.chatScrollByThread,
        [threadId]: { ...prev, followBottom: true },
      }
      persistChatScrollByThread(merged)
      return { chatScrollByThread: merged }
    }),
  setInput: (input) => set({ input }),
  appendInputText: (text) => set((state) => ({ input: state.input + text })),
  setError: (error) => set({ error }),
  setSelectedModel: (modelId) => {
    if (!AGENT_MODELS.some((m) => m.id === modelId)) return
    persistModelId(modelId)
    set({ selectedModelId: modelId })
  },
  setSelectedImageChannel: (channelId) => {
    if (!isSelectableImageChannel(channelId)) return
    persistImageChannel(channelId)
    set({ selectedImageChannel: channelId })
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
  notifyCanvasOpened: () =>
    set({
      pendingCanvasContext:
        '[canvas] 用户刚打开了 CATIMATION 画布，正在看着它。画布现在是当前操作面。' +
        '需要查看内容时调用 canvas_snapshot（返回所有形状 + 整张画布的 PNG 路径，可直接打开查看）；' +
        '不要说你看不到画布。在画布上生图/改图请用 canvas_* + generate_image 工具。',
    }),
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
  applyGoalEvent: (event) => {
    if (event.type === 'goal_updated') {
      const { threadId, goal } = event
      // Detect a status *transition* into an attention state so the autonomous
      // goal loop can alert the user (blocked/budget/usage/complete) without
      // them watching the chip. Token-only ticks (status unchanged) stay silent.
      const prev = get().goalByThread[threadId]
      set((state) => ({ goalByThread: { ...state.goalByThread, [threadId]: goal } }))
      if (prev && prev.status !== goal.status) {
        const notice = goalTransitionNotice(threadId, goal)
        if (notice) get().pushNotice(notice)
      }
    } else if (event.type === 'goal_cleared') {
      const { threadId } = event
      set((state) => ({ goalByThread: { ...state.goalByThread, [threadId]: null } }))
    }
  },
  refreshGoal: async (threadId) => {
    const target = threadId ?? get().threadId
    if (!target) return
    const getGoal = getAgentApi().getGoal
    if (!getGoal) return
    try {
      const res = await getGoal(target)
      if (!res.ok) return
      set((state) => ({ goalByThread: { ...state.goalByThread, [target]: res.data ?? null } }))
    } catch {
      // Best-effort read; leave prior state intact on transport failure.
    }
  },
  setGoal: async (objective, tokenBudget) => {
    const threadId = get().threadId
    const trimmed = objective.trim()
    if (!threadId) {
      get().pushNotice({
        id: `goal-no-thread:${Date.now()}`,
        kind: 'configWarning',
        level: 'info',
        message: '先发一条消息创建会话,再用 /goal 设定长期目标。',
      })
      return
    }
    if (!trimmed) return
    // Codex caps objectives at 4000 chars (put long specs in a file + point at it).
    if (trimmed.length > 4000) {
      get().pushNotice({
        id: `goal-too-long:${Date.now()}`,
        kind: 'configWarning',
        level: 'warning',
        message: '目标过长(>4000 字符)。把细节放进文件,用 /goal 指向它,例如 “/goal 按 specs.md 完成迁移”。',
      })
      return
    }
    const setGoalApi = getAgentApi().setGoal
    if (!setGoalApi) {
      set({ error: 'Goal API 不可用(需要 Codex 后端)。' })
      return
    }
    try {
      const res = await setGoalApi(threadId, { objective: trimmed, tokenBudget })
      if (!res.ok) throw new Error(res.error ?? 'Failed to set goal')
      set((state) => ({ goalByThread: { ...state.goalByThread, [threadId]: res.data ?? null } }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
  setGoalStatus: async (status) => {
    const threadId = get().threadId
    if (!threadId) return
    const current = get().goalByThread[threadId]
    if (!current) {
      get().pushNotice({
        id: `goal-none:${Date.now()}`,
        kind: 'configWarning',
        level: 'info',
        message: '当前会话还没有目标。用 “/goal 你的目标” 先设一个。',
      })
      return
    }
    const setGoalApi = getAgentApi().setGoal
    if (!setGoalApi) return
    try {
      const res = await setGoalApi(threadId, { status })
      if (!res.ok) throw new Error(res.error ?? 'Failed to update goal status')
      set((state) => ({ goalByThread: { ...state.goalByThread, [threadId]: res.data ?? null } }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
  setGoalBudget: async (tokenBudget) => {
    const threadId = get().threadId
    if (!threadId) return
    const current = get().goalByThread[threadId]
    if (!current) {
      get().pushNotice({
        id: `goal-budget-none:${Date.now()}`,
        kind: 'configWarning',
        level: 'info',
        message: '当前会话还没有目标。先用 “/goal 你的目标” 设一个,再设预算。',
      })
      return
    }
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return
    const setGoalApi = getAgentApi().setGoal
    if (!setGoalApi) return
    try {
      const res = await setGoalApi(threadId, { tokenBudget })
      if (!res.ok) throw new Error(res.error ?? 'Failed to set goal budget')
      set((state) => ({ goalByThread: { ...state.goalByThread, [threadId]: res.data ?? null } }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
  clearGoal: async () => {
    const threadId = get().threadId
    if (!threadId) return
    const clearGoalApi = getAgentApi().clearGoal
    if (!clearGoalApi) return
    try {
      const res = await clearGoalApi(threadId)
      if (!res.ok) throw new Error(res.error ?? 'Failed to clear goal')
      set((state) => ({ goalByThread: { ...state.goalByThread, [threadId]: null } }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
  compact: async () => {
    const threadId = get().threadId
    const compactApi = getAgentApi().compactThread
    if (!compactApi) {
      get().pushNotice({
        id: `compact-unavailable:${Date.now()}`,
        kind: 'configWarning',
        level: 'warning',
        message: '当前后端不支持手动压缩(/compact)。',
      })
      return
    }
    if (!threadId) {
      get().pushNotice({
        id: `compact-no-thread:${Date.now()}`,
        kind: 'configWarning',
        level: 'info',
        message: '先发一条消息创建会话,再压缩上下文(/compact)。',
      })
      return
    }
    try {
      const res = await compactApi(threadId)
      if (!res.ok) throw new Error(res.error ?? 'Failed to start compaction')
      get().pushNotice({
        id: `compact-started:${Date.now()}`,
        kind: 'configWarning',
        level: 'info',
        threadId,
        message: '正在压缩上下文…(总结并丢弃旧历史,释放上下文窗口)',
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
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
    // One-shot canvas-open hook: rides this turn as a hidden prefix so Codex is
    // canvas-aware without mutating the visible user message. See notifyCanvasOpened.
    const canvasContext = state.pendingCanvasContext
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
      pendingCanvasContext: null,
      error: undefined,
      isRunning: true,
      messages: [...current.messages, userMsg],
      // Mark this thread running for the sidebar dots. For a brand-new chat
      // (no threadId yet) the flag is set once `result.threadId` resolves /
      // the first event is adopted below.
      runningByThread: state.threadId
        ? { ...current.runningByThread, [state.threadId]: true }
        : current.runningByThread,
    }))
    // sendMessage = explicit user intent to track the reply tail. Re-lock the
    // current thread's scroll even if the user had scrolled up earlier. New
    // threads (no threadId yet) get locked once result.threadId resolves below.
    if (state.threadId) {
      get().lockChatScrollToBottom(state.threadId)
    }

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
        content: canvasContext ? `${canvasContext}\n\n${content}` : content,
        attachments,
        references,
        currentPage: window.location.hash.slice(1),
        model: modelId,
        skills: skills.length > 0 ? skills : undefined,
      })
      const wasNewThread = state.threadId == null
      set((current) => ({
        threadId: result.threadId,
        runningByThread: { ...current.runningByThread, [result.threadId]: true },
      }))
      get().lockChatScrollToBottom(result.threadId)
      // Refresh the sidebar immediately so a brand-new chat's row appears the
      // moment it's sent (the thread is already persisted by `sendMessage`).
      // Previously the list only refreshed via the delayed title-refresh
      // schedule fired on `turn_completed`, so users waited the whole turn for
      // the new thread to show up. Also reorders the just-used thread to top.
      if (wasNewThread) {
        void get().refreshThreadList()
      }
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
      set((current) => {
        const runningByThread = { ...current.runningByThread }
        if (state.threadId) delete runningByThread[state.threadId]
        return {
          input: content,
          attachments,
          pendingReferences: state.pendingReferences,
          isRunning: false,
          error: error instanceof Error ? error.message : String(error),
          messages: current.messages.slice(0, -1),
          runningByThread,
        }
      })
    }
  },
  steer: async () => {
    const state = get()
    const content = state.input.trim()
    const attachments = state.attachments
    const references = state.pendingReferences
    // Steering only makes sense mid-turn on an existing thread. If nothing is
    // running, defer to a normal send so a stray call never silently drops input.
    if (!state.isRunning || !state.threadId) {
      await get().send()
      return
    }
    if (!content && attachments.length === 0 && references.length === 0) return
    const steer = getAgentApi().steer
    if (!steer) {
      // Preload without steer support (older shell) — fall back to queue-on-send.
      return
    }

    const now = Date.now()
    const items: TimelineItem[] = []
    if (attachments.length > 0) {
      const refs: AttachmentRef[] = attachments.map((a) => {
        const uri = buildAttachmentUri(a)
        const hasUri = typeof uri === 'string' && uri.length > 0
        let kind: AttachmentRef['kind'] = 'file'
        if (hasUri) {
          if (a.mime.startsWith('image/')) kind = 'image'
          else if (a.mime.startsWith('video/')) kind = 'video'
        }
        return { id: createId(), kind, name: a.name, mime: a.mime, size: a.size, uri: uri ?? '' }
      })
      items.push({ type: 'attachment', id: createId(), startedAt: now, attachments: refs })
    }
    if (content.length > 0) {
      items.push({ type: 'text', id: createId(), startedAt: now, content })
    }
    const userMsg: Message = { id: createId(), role: 'user', createdAt: now, items }
    const threadId = state.threadId

    // Optimistically append the interjection; the running turn stays live.
    set((current) => ({
      input: '',
      attachments: [],
      error: undefined,
      messages: [...current.messages, userMsg],
    }))
    get().lockChatScrollToBottom(threadId)

    const tokens = extractSkillTokens(content)
    const known = new Map(state.availableSkills.map((s) => [s.name, s.path]))
    const skills = Array.from(new Set(tokens))
      .map((name) => {
        const path = known.get(name)
        return path ? { name, path } : null
      })
      .filter((s): s is { name: string; path: string } => s !== null)

    try {
      const result = await steer({
        threadId,
        content,
        attachments,
        references,
        currentPage: window.location.hash.slice(1),
        model: state.selectedModelId,
        skills: skills.length > 0 ? skills : undefined,
      })
      if (result.userMessageItems && result.userMessageItems.length > 0) {
        const canonicalItems = result.userMessageItems
        set((current) => ({
          messages: current.messages.map((m) =>
            m.id === userMsg.id ? { ...m, items: canonicalItems } : m,
          ),
        }))
      }
      get().clearPendingReferences()
      void useFileExplorerStore.getState().refreshAttachmentsTree().catch(() => undefined)
    } catch (error) {
      // Steer rejected (turn already ended, or no active turn): drop the
      // optimistic bubble and restore the draft so the user can resend it.
      set((current) => ({
        input: content,
        attachments,
        pendingReferences: references,
        error: error instanceof Error ? error.message : String(error),
        messages: current.messages.filter((m) => m.id !== userMsg.id),
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
    const restoredAttachments = attachmentsFromMessage(target)

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
      // Main returns canonical local-file:// uploads-cache paths after send;
      // those ARE rehydratable, so editing a sent message preserves attached
      // images/files. Blob/data-only optimistic refs are intentionally skipped.
      attachments: restoredAttachments,
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
    // The turn is going away — settle any pending ask_user cards in this view as
    // abandoned so the agent's blocked call returns and the card stops being
    // clickable (otherwise it hangs until the ~33-min renderer-tool timeout).
    const expiredIds: string[] = []
    set((s) => {
      const r = expirePendingChoices(s.messages)
      expiredIds.push(...r.ids)
      return r.messages === s.messages ? {} : { messages: r.messages }
    })
    resolveAbandonedChoices(expiredIds)
    const clearRunning = (extra: Partial<AgentChatState>): void =>
      set((s) => {
        const runningByThread = { ...s.runningByThread }
        delete runningByThread[threadId]
        return { isRunning: false, runningByThread, ...extra }
      })
    try {
      await getAgentApi().cancel({ threadId })
      clearRunning({})
    } catch (error) {
      clearRunning({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  newThread: () =>
    set((current) => {
      // Snapshot the outgoing chat so a still-running turn keeps streaming into
      // its background slice instead of being dropped (the backend turn is NOT
      // cancelled — main + CodexProtocolClient are per-(thread,turn) safe).
      const threadSlices = { ...current.threadSlices }
      if (current.threadId) {
        threadSlices[current.threadId] = {
          messages: current.messages,
          isRunning: current.isRunning,
          tokenUsage: current.tokenUsage,
          error: current.error,
        }
      }
      return {
        threadSlices,
        threadId: undefined,
        messages: [],
        isRunning: false,
        error: undefined,
        tokenUsage: undefined,
        // Fresh session => fresh watermark dedup for the active view.
        contextWatermarkSeen: {},
        pendingApprovals: [],
        rewoundTurns: [],
        editingMessageId: undefined,
        draftBackup: undefined,
      }
    }),
  switchThread: async (threadId: string) => {
    if (get().threadId === threadId) return

    // Prefer the live background slice (a chat that streamed while we were
    // viewing another one) — it's fresher than the persisted server snapshot.
    let restored: ThreadSlice | null = get().threadSlices[threadId] ?? null

    if (!restored) {
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
              createdAt?: string | number | Date
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
              // `agent:open-thread` normalizes this to an epoch number; we still
              // accept string/Date defensively. Fall back to 0 (NOT Date.now())
              // for an unrecoverable timestamp — stamping a reloaded message with
              // the reopen time is exactly what made codex image bubbles drift to
              // the top of the conversation.
              createdAt: toEpochMs(r.createdAt) ?? 0,
            }
          })
        : []

      restored = {
        // Re-attach codex-generated image bubbles persisted for this thread. The
        // durable URLs come from the history record (cloud bucket), so reloads /
        // thread switches show the thumbnail again instead of losing it.
        messages: rehydrateCodexArtifacts(threadId, messages),
        // A persisted thread isn't streaming unless we already tracked it as
        // running (rare race) — honor the cross-thread flag if set.
        isRunning: get().runningByThread[threadId] ?? false,
        tokenUsage: undefined,
        error: undefined,
      }
    }

    // Commit atomically: snapshot the OUTGOING active view into its background
    // slice (so its in-flight turn keeps streaming there), drop the incoming
    // thread from the background map (it's the active view now), and install it.
    set((cur) => {
      const threadSlices = { ...cur.threadSlices }
      if (cur.threadId) {
        threadSlices[cur.threadId] = {
          messages: cur.messages,
          isRunning: cur.isRunning,
          tokenUsage: cur.tokenUsage,
          error: cur.error,
        }
      }
      delete threadSlices[threadId]
      return {
        threadId,
        threadSlices,
        messages: restored!.messages,
        isRunning: restored!.isRunning,
        tokenUsage: restored!.tokenUsage,
        error: restored!.error,
        pendingApprovals: [],
      }
    })
  },
  applyEvent: (event) => {
    // Panel-global events (no per-thread routing).
    if (event.type === 'skills_changed') {
      void get().loadAvailableSkills()
      return
    }
    if (event.type === 'notice') {
      // `steerFallback` means the main process converted a lost turn/steer
      // race into a FRESH turn on this thread (AgentManager.steer). Our
      // isRunning went false at the original turn_completed, so re-arm it —
      // otherwise the fallback turn streams with no stop button and no
      // sidebar dot, and the user could fire a parallel send into it.
      const noticeThreadId = event.notice.threadId
      if (event.notice.kind === 'steerFallback' && noticeThreadId) {
        set((state) => ({
          runningByThread: { ...state.runningByThread, [noticeThreadId]: true },
          ...(state.threadId === noticeThreadId ? { isRunning: true } : {}),
        }))
      }
      // Notices render as panel-wide banners; show regardless of which thread
      // they came from now that multiple chats can stream at once.
      get().pushNotice(event.notice)
      return
    }
    if (event.type === 'mcp_status_updated' || event.type === 'mcp_oauth_completed') {
      // Subscribed to via a dedicated `agent:mcp-*` IPC channel in MCPSection.
      return
    }
    if (event.type === 'attachment_error') {
      get().pushNotice({
        id: `attachment-${event.name}-${Date.now()}`,
        kind: 'attachmentSkipped',
        level: 'warning',
        message: `已跳过 ${event.name}：${event.error}`,
        threadId: event.threadId,
      })
      return
    }

    const evtId =
      'threadId' in event && typeof event.threadId === 'string' ? event.threadId : undefined

    // Cross-thread running flag (drives the ThreadSidebar dots) + thread-list
    // title refresh — both fire for ANY thread, active or background.
    // willRetry errors are transient — the backend is re-streaming the same
    // turn, so the thread is still running and must keep its sidebar dot.
    if (
      event.type === 'turn_completed' ||
      event.type === 'cancelled' ||
      (event.type === 'error' && !event.willRetry)
    ) {
      if (evtId && get().runningByThread[evtId]) {
        const next = { ...get().runningByThread }
        delete next[evtId]
        set({ runningByThread: next })
      }
    }
    if (event.type === 'turn_completed') {
      scheduleThreadListTitleRefreshes(() => void get().refreshThreadList())
    }

    // Route to the ACTIVE view or a BACKGROUND slice.
    //
    // Adoption: an unsaved new chat (threadId undefined) that we just sent into
    // (isRunning) must bind to ITS OWN freshly-created thread. We key adoption
    // strictly on `thread_created` — Codex emits it first (from `thread/start`)
    // for a brand-new thread, and existing background threads never re-emit it.
    // Keying on `isRunning` alone (the previous logic) let a concurrently
    // running background thread's deltas get adopted into the new chat — i.e.
    // "上一个任务出现在下一个任务里". `thread_created` is the unambiguous signal.
    const activeThreadId = get().threadId
    let isActive: boolean
    if (activeThreadId != null) {
      isActive = evtId === activeThreadId
    } else if (event.type === 'thread_created' && get().isRunning && evtId != null) {
      set({ threadId: evtId, runningByThread: { ...get().runningByThread, [evtId]: true } })
      isActive = true
    } else {
      isActive = false
    }

    if (isActive) {
      const s = get()
      const before: ThreadSlice = {
        messages: s.messages,
        isRunning: s.isRunning,
        tokenUsage: s.tokenUsage,
        error: s.error,
      }
      const after = reduceThreadSlice(before, event)
      if (after !== before) {
        set({
          messages: after.messages,
          isRunning: after.isRunning,
          tokenUsage: after.tokenUsage,
          error: after.error,
        })
      }
      // Proactive 70% context watermark (active thread only — it needs the
      // visible threadId). See `deriveContextWatermarkNotice` (openai/codex#10823).
      if (event.type === 'token_usage_updated') {
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
      }
      return
    }

    // Background thread: keep accumulating into its slice so a later
    // switchThread restores the full, up-to-date conversation. The backend
    // turn keeps running regardless — we just stopped showing it live.
    if (!evtId) return
    const prev = get().threadSlices[evtId] ?? EMPTY_THREAD_SLICE
    const next = reduceThreadSlice(prev, event)
    if (next !== prev) {
      set({ threadSlices: { ...get().threadSlices, [evtId]: next } })
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
    // Unblock any pending ask_user cards owned by the deleted thread (active view
    // OR a background slice) so their blocked agent calls return instead of
    // leaking a resolver forever.
    const expiredIds: string[] = []
    set((s) => {
      const isActive = s.threadId === threadId
      const msgs = isActive ? s.messages : s.threadSlices[threadId]?.messages
      if (!msgs) return {}
      const r = expirePendingChoices(msgs)
      expiredIds.push(...r.ids)
      if (r.messages === msgs) return {}
      if (isActive) return { messages: r.messages }
      const slice = s.threadSlices[threadId]
      if (!slice) return {}
      return { threadSlices: { ...s.threadSlices, [threadId]: { ...slice, messages: r.messages } } }
    })
    resolveAbandonedChoices(expiredIds)
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
