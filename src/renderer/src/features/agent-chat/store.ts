import { create } from 'zustand'
import {
  loadChatScrollByThread,
  persistChatScrollByThread,
  type ChatScrollByThread,
  type ChatScrollState,
} from './chatScroll'
import type {
  AgentAttachmentInput,
  AgentCollaborationCapabilities,
  AgentCollaborationModeUpdatePayload,
  AgentCollaborationModeUpdateResult,
  AgentMentionRef,
  AgentNotice,
  AgentStreamEvent,
  AgentThreadSummary,
  AgentTokenUsage,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexSkillSummary,
  CodexThreadSummary,
  ItemDeltaPatch,
} from '../../../../types/agent'
import type { ThreadGoal, ThreadGoalStatus } from '../../../../types/codexGoals'
import type { PluginInstalledResponse } from '../../../../types/codexPlugins'
import type { AgentReference } from '../../../../types/agent-reference'
import type { ArtifactItem, ArtifactSaveInfo, AttachmentRef, ChoiceAnswer, ChoiceOption, ChoiceRequestItem, FileChange, Message, PlanStep, TimelineItem } from '../../../../types/agent-timeline'
import {
  dropSupersededStreamItemsInLastMessage,
  trimRetriedStreamItemsInLastMessage,
  patchExistingItem,
  upsertItemInLastMessage,
} from '../../../../types/agent-timeline'
import {
  isPlanReasoningEffort,
  type CollaborationModeKind,
  type PlanReasoningEffort,
} from '../../../../shared/collaborationMode'
import {
  defaultContextWindowForModel,
  isModelReasoningEffort,
  migrateLegacyModelSelection,
  type ModelReasoningEffort,
} from '../../../../shared/modelSettings'
import { DEFAULT_MODEL_ID, resolveModelSelection } from './models'
import {
  CANONICAL_SELECTED_MODEL_STORAGE_KEY,
  MODEL_CONTEXT_STORAGE_KEY,
  cancelQueuedModelContextIntent,
  createModelRoutingSlice,
  isSafeModelSettingsKey,
  persistCanonicalModelId,
  updateModelSettingsPersistenceWarning,
  type ModelRoutingSlice,
  type ModelSettingsPersistenceWarnings,
} from './modelRoutingSlice'
import { contextUsedPercent } from './contextWindowDefaults'
import { DEFAULT_IMAGE_CHANNEL_ID, isSelectableImageChannel } from './imageChannels'
import { useFileExplorerStore } from '../file-explorer/store'
import { rehydrateCodexArtifacts } from './codexArtifactPersistence'
import { appendStreamedDiff } from '../../../../shared/diffUtils'
import { getAgentApi } from '../../utils/agentBridge'

const LEGACY_SELECTED_MODEL_STORAGE_KEY = 'catimation.agent.selectedModel'
const MODEL_REASONING_STORAGE_KEY = 'agent.modelReasoningByModel:v1'
const SELECTED_IMAGE_CHANNEL_STORAGE_KEY = 'catimation.agent.selectedImageChannel'
const PLAN_EFFORT_STORAGE_KEY = 'agent.planReasoningEffort:v1'
const THREAD_MODE_STORAGE_KEY = 'agent.collaborationModesByThread:v1'
const THREAD_MODE_STORAGE_LIMIT = 200
const DELETED_THREAD_TOMBSTONE_LIMIT = 200
const COLLAB_MODE_LIFECYCLE_LIMIT = DELETED_THREAD_TOMBSTONE_LIMIT
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
let nextComposerAttachmentId = 0

function isCollaborationModeKind(value: unknown): value is CollaborationModeKind {
  return value === 'default' || value === 'plan'
}

function readPlanReasoningEffort(): PlanReasoningEffort {
  try {
    const value = globalThis.localStorage?.getItem(PLAN_EFFORT_STORAGE_KEY)
    return isPlanReasoningEffort(value) ? value : 'auto'
  } catch {
    return 'auto'
  }
}

function persistPlanReasoningEffort(value: PlanReasoningEffort): void {
  try {
    globalThis.localStorage?.setItem(PLAN_EFFORT_STORAGE_KEY, value)
  } catch {
    // Storage is optional in private/restricted renderer contexts.
  }
}

function limitThreadCollaborationModes(
  modes: Record<string, CollaborationModeKind>,
): Record<string, CollaborationModeKind> {
  const entries = Object.entries(modes)
    .filter(
      (entry): entry is [string, CollaborationModeKind] =>
        isCollaborationModeKind(entry[1]),
    )
    .slice(-THREAD_MODE_STORAGE_LIMIT)
  return Object.fromEntries(entries)
}

function readThreadCollaborationModes(): Record<string, CollaborationModeKind> {
  try {
    const raw = globalThis.localStorage?.getItem(THREAD_MODE_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return limitThreadCollaborationModes(Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, CollaborationModeKind] =>
          isCollaborationModeKind(entry[1]),
      ),
    ))
  } catch {
    return {}
  }
}

function persistThreadCollaborationModes(
  modes: Record<string, CollaborationModeKind>,
): void {
  try {
    globalThis.localStorage?.setItem(
      THREAD_MODE_STORAGE_KEY,
      JSON.stringify(limitThreadCollaborationModes(modes)),
    )
  } catch {
    // Storage is optional in private/restricted renderer contexts.
  }
}

function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function withBoundedLifecycleGeneration(
  generations: Record<string, number>,
  threadId: string,
  generation: number,
): Record<string, number> {
  const next = { ...generations }
  // Reinsert so object order is an LRU-like order aligned with tombstone cleanup.
  delete next[threadId]
  next[threadId] = generation
  const entries = Object.entries(next).slice(-COLLAB_MODE_LIFECYCLE_LIMIT)
  return Object.fromEntries(entries)
}

const restoredThreadCollaborationModes = readThreadCollaborationModes()
const restoredCollaborationThreads = Object.fromEntries(
  Object.keys(restoredThreadCollaborationModes).map((threadId) => [threadId, true] as const),
)
function fallbackCollaborationCapabilities(providerId: string): AgentCollaborationCapabilities {
  return {
    providerId,
    planDefaultEffort: null,
    supportedPlanEfforts: [],
    source: 'fallback',
  }
}

/**
 * Owner id used to reconcile a capabilities payload against the Gateway id
 * that renderer callers pass to `loadCollaborationCapabilities`. Main reports
 * the internal Channel id (e.g. `apiyi-standard`) as `providerId` since the
 * Gateway/Channel split, so ownership must compare `gatewayId` when present.
 */
function capabilitiesOwnerGatewayId(
  capabilities: Pick<AgentCollaborationCapabilities, 'providerId' | 'gatewayId'>,
): string {
  return capabilities.gatewayId ?? capabilities.providerId
}
const deletedCollaborationThreadTombstones = new Map<string, number>()

function addDeletedThreadTombstone(threadId: string, generation: number): void {
  // Reinsert so Map order reflects the latest deletion before trimming. The
  // value identifies which deletion a pending explicit reopen expects.
  deletedCollaborationThreadTombstones.delete(threadId)
  deletedCollaborationThreadTombstones.set(threadId, generation)
  while (deletedCollaborationThreadTombstones.size > DELETED_THREAD_TOMBSTONE_LIMIT) {
    const oldest = deletedCollaborationThreadTombstones.keys().next().value
    if (typeof oldest !== 'string') break
    deletedCollaborationThreadTombstones.delete(oldest)
  }
}

function clearDeletedThreadTombstone(threadId: string): void {
  deletedCollaborationThreadTombstones.delete(threadId)
}

function withComposerAttachmentId(attachment: AgentAttachmentInput): AgentAttachmentInput {
  if (attachment.composerId) return attachment
  nextComposerAttachmentId += 1
  const identified = { ...attachment }
  // UI-only metadata stays non-enumerable so the existing attachment payload
  // contract and persisted/edit-restored value shape remain byte-for-byte clean.
  Object.defineProperty(identified, 'composerId', {
    configurable: false,
    enumerable: false,
    value: `composer-attachment:${Date.now()}:${nextComposerAttachmentId}`,
    writable: false,
  })
  return identified
}

function scheduleThreadListTitleRefreshes(run: () => void): void {
  for (const delay of THREAD_LIST_TITLE_REFRESH_DELAYS_MS) {
    setTimeout(run, delay)
  }
}


function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readModelReasoningEfforts(): Record<string, ModelReasoningEffort> {
  try {
    const raw = globalThis.localStorage?.getItem(MODEL_REASONING_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainRecord(parsed)) return {}
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, ModelReasoningEffort] =>
        isSafeModelSettingsKey(entry[0]) && isModelReasoningEffort(entry[1]),
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

function readModelContextWindows(): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(MODEL_CONTEXT_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainRecord(parsed)) return {}
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        isSafeModelSettingsKey(entry[0])
        && typeof entry[1] === 'number'
        && Number.isFinite(entry[1])
        && Number.isInteger(entry[1])
        && entry[1] > 0,
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

function persistModelReasoningEfforts(
  efforts: Record<string, ModelReasoningEffort>,
): boolean {
  try {
    const storage = globalThis.localStorage
    if (!storage) return false
    storage.setItem(
      MODEL_REASONING_STORAGE_KEY,
      JSON.stringify(efforts),
    )
    return true
  } catch {
    // Storage is optional in private/restricted renderer contexts.
    return false
  }
}

interface RestoredModelSettings {
  selectedModelId: string
  modelReasoningEffortByModel: Record<string, ModelReasoningEffort>
  modelContextWindowByModel: Record<string, number>
  persistenceWarnings: AgentChatState['modelSettingsPersistenceWarnings']
}

function restoreModelSettings(): RestoredModelSettings {
  const modelReasoningEffortByModel = readModelReasoningEfforts()
  const modelContextWindowByModel = readModelContextWindows()
  const persistenceWarnings:
    AgentChatState['modelSettingsPersistenceWarnings'] = {}
  let selectedModelId = DEFAULT_MODEL_ID

  try {
    const canonical = globalThis.localStorage?.getItem(
      CANONICAL_SELECTED_MODEL_STORAGE_KEY,
    )
    if (canonical !== null && canonical !== undefined) {
      selectedModelId =
        canonical.trim().length > 0 ? canonical : DEFAULT_MODEL_ID
      if (
        selectedModelId !== canonical
        && !persistCanonicalModelId(selectedModelId)
      ) {
        persistenceWarnings.model =
          '模型设置仅本次会话有效，未能持久化。'
      }
      return {
        selectedModelId,
        modelReasoningEffortByModel,
        modelContextWindowByModel,
        persistenceWarnings,
      }
    }

    const legacy = globalThis.localStorage?.getItem(
      LEGACY_SELECTED_MODEL_STORAGE_KEY,
    )
    const migrated = migrateLegacyModelSelection(legacy || DEFAULT_MODEL_ID)
    selectedModelId = migrated.model || DEFAULT_MODEL_ID
    const needsLegacyEffortWrite =
      migrated.migrated
      && migrated.reasoningEffort !== 'auto'
      && !Object.prototype.hasOwnProperty.call(
        modelReasoningEffortByModel,
        selectedModelId,
      )
    if (needsLegacyEffortWrite) {
      modelReasoningEffortByModel[selectedModelId] = migrated.reasoningEffort
      if (!persistModelReasoningEfforts(modelReasoningEffortByModel)) {
        persistenceWarnings.reasoning =
          'Reasoning 设置仅本次会话有效，未能持久化。'
        return {
          selectedModelId,
          modelReasoningEffortByModel,
          modelContextWindowByModel,
          persistenceWarnings,
        }
      }
    }
    if (!persistCanonicalModelId(selectedModelId)) {
      persistenceWarnings.model =
        '模型设置仅本次会话有效，未能持久化。'
    }
  } catch {
    // Keep safe in-memory defaults when storage access itself is unavailable.
  }

  return {
    selectedModelId,
    modelReasoningEffortByModel,
    modelContextWindowByModel,
    persistenceWarnings,
  }
}

const restoredModelSettings = restoreModelSettings()

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

/**
 * Extract `@token` plugin-mention markers from a chat input. Mirrors the
 * codex app-server "Invoke a plugin" syntax — the UI mention token (e.g.
 * `@sample`) stays in the text while a `mention` input item with the exact
 * `plugin://<name>@<marketplace>` path rides along. `@` only counts at start
 * of input or after whitespace, and requires a following non-`@` word char,
 * so emails (`me@example.com`) and mid-word `@` never trigger. Tokens allow
 * dots so marketplace-style names like `@org.tool` survive.
 *
 * Used by `send()`/`steer()` to resolve tokens against
 * `availablePluginMentions` and forward `payload.mentions`.
 */
export function extractMentionTokens(text: string): string[] {
  const out: string[] = []
  const re = /(?:^|\s)@([A-Za-z0-9_][\w.-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(m[1])
  }
  return out
}

/**
 * A plugin the user can invoke with `@token`. `token` is the plugin's wire
 * name (what the user types), `name` is the display name shown in the popup
 * and sent on the mention item, `path` is the exact
 * `plugin://<plugin-name>@<marketplace-name>` from `plugin/installed`.
 */
export interface PluginMentionCandidate {
  token: string
  name: string
  path: string
}

/**
 * Flatten a `plugin/installed` response into mention candidates: only
 * installed + enabled + not admin-disabled plugins are invocable per the
 * codex README ("mention item with the exact path returned by
 * plugin/installed").
 */
export function pluginMentionCandidates(response: PluginInstalledResponse): PluginMentionCandidate[] {
  const out: PluginMentionCandidate[] = []
  for (const marketplace of response.marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!plugin.installed || !plugin.enabled || plugin.availability === 'DISABLED_BY_ADMIN') continue
      out.push({
        token: plugin.name,
        name: plugin.interface?.displayName ?? plugin.name,
        path: `plugin://${plugin.name}@${marketplace.name}`,
      })
    }
  }
  return out
}

/**
 * Resolve `@token`s in `content` to mention refs against the installed-plugin
 * cache. Unknown tokens travel as plain text (codex tolerates a bare token —
 * it just falls back to guessing by name). Dedupe by path so `@foo @foo`
 * yields one mention item.
 */
function resolveMentions(content: string, candidates: PluginMentionCandidate[]): AgentMentionRef[] | undefined {
  if (candidates.length === 0) return undefined
  const byToken = new Map(candidates.map((c) => [c.token, c]))
  const seen = new Set<string>()
  const out: AgentMentionRef[] = []
  for (const token of extractMentionTokens(content)) {
    const candidate = byToken.get(token)
    if (!candidate || seen.has(candidate.path)) continue
    seen.add(candidate.path)
    out.push({ name: candidate.name, path: candidate.path })
  }
  return out.length > 0 ? out : undefined
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

/**
 * Composer state captured when a send fails, so 重试 can replay the exact
 * payload through `send()` without the user retyping anything.
 */
export interface FailedSendSnapshot {
  content: string
  attachments: AgentAttachmentInput[]
  references: AgentReference[]
  canvasContext: string | null
}

type CollabModeCompatibility = 'immediate' | 'next-turn'

interface AgentChatState extends ModelRoutingSlice {
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
  /**
   * 「视频工作台批次跑完了」的待投递通知，按线程分桶。turn 结束后没有通道能把
   * 消息塞给模型，所以在这里排队，随该线程的下一条用户消息作为隐藏前缀一起走
   * （与 pendingCanvasContext 同款）—— 不自动开 turn，因此不会有意外的 token 花费。
   * 线程正在跑时不入队，直接 steer 插进当前 turn。见 notifyWorkbenchBatchDone。
   */
  pendingWorkbenchNoticesByThread: Record<string, string[]>
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
   * True while `submitEditMessage` is awaiting the main-process context
   * branch (`agent:thread-branch-before-message`). Guards against a double
   * submit racing two forks / two sends off the same edit.
   */
  editBranchPending: boolean
  /**
   * Stash of "rewound" turns (a user message + every assistant message
   * that followed it, up to but not including the next user message).
   * Each entry preserves the slice plus the index it occupied in
   * `messages` so a later restore can splice it back in place. The drawer
   * UI renders these as one-line clickable rows above the bottom composer.
   * Newest first.
   */
  rewoundTurns: RewoundTurn[]
  /**
   * Composer snapshots of FAILED sends, keyed by the optimistic message id.
   * Powers the Cursor-style failed bubble: the message stays in the timeline
   * marked `sendState: 'failed'` and 重试 replays the snapshot through the
   * full `send()` pipeline (skills/mentions resolution included).
   */
  failedSendSnapshots: Record<string, FailedSendSnapshot>
  isRunning: boolean
  error?: string
  /** Ordinary/default-mode reasoning preference, independently persisted per model. */
  modelReasoningEffortByModel: Record<string, ModelReasoningEffort>
  modelContextWindowByModel: Record<string, number>
  activeModelContextWindow: number
  modelContextPending?: {
    model: string
    contextWindow: number
    requestVersion: number
  }
  /** Sticky fatal owner set when rollback cannot prove an effective backend config. */
  modelSettingsRecoveryRequired: boolean
  modelSettingsPersistenceWarnings: ModelSettingsPersistenceWarnings
  /** Invalidates older catalog/context bootstrap reads after Provider changes. */
  modelSettingsLoadGeneration: number
  /** Monotonic owner for model-context apply results. */
  modelContextRequestSequence: number
  /** User-selected image render channel (authoritative for generate_image). */
  selectedImageChannel: string
  /** Current composer target/display for the active thread or unsaved draft. */
  collabModeKind: CollaborationModeKind
  /**
   * Last server-confirmed mode in this renderer session. Restart-restored
   * entries are present here for thread switching but remain marked in
   * `collabModeRestoredByThread` until a live server event confirms them.
   */
  collabModeByThread: Record<string, CollaborationModeKind>
  /** In-flight existing-thread requests; confirmed state remains untouched. */
  collabModePendingByThread: Record<string, {
    target: CollaborationModeKind
    requestVersion: number
  }>
  /** Store-wide monotonic source for requestVersion; never reset on delete/reopen. */
  collabModeRequestSequence: number
  /** Latest requestVersion per thread; safe to clear because the sequence is global. */
  collabModeRequestVersionByThread: Record<string, number>
  /** Store-wide monotonic source for lifecycle generations. */
  collabModeLifecycleSequence: number
  /** Bounded delete/reopen generation authority per recently known thread id. */
  collabModeLifecycleByThread: Record<string, number>
  /** Latest async thread navigation; older openThread results must not commit. */
  collabModeNavigationSequence: number
  /**
   * Display-only compatibility reported by the latest non-stale response.
   * Never use this to skip renderer IPC: AgentManager owns the backend-epoch
   * support cache so a Codex restart can probe the new generation again.
   */
  collabModeCompatibility: CollabModeCompatibility
  /** Per-thread compatibility authority; top-level value is the active projection. */
  collabModeCompatibilityByThread: Record<string, CollabModeCompatibility>
  /** Restart cache entries that still require explicit next-turn submission. */
  collabModeRestoredByThread: Record<string, true>
  /** Unconfirmed targets retained when immediate settings update is unavailable. */
  collabModeNextTurnByThread: Record<string, CollaborationModeKind>
  /** Global Plan-only effort preference, independent from model/default effort. */
  planReasoningEffort: PlanReasoningEffort
  collaborationCapabilities?: AgentCollaborationCapabilities
  /** Canonical model slug that owns `collaborationCapabilities`. */
  collaborationCapabilitiesModel?: string
  /** Monotonic request owner used to discard stale Provider/model responses. */
  collaborationCapabilityRequestSequence: number
  /**
   * Explicit Plan effort awaiting capabilities for one model/thread owner.
   * Carries every owner dimension so model, thread, or preference changes
   * invalidate it instead of applying settings to another active thread.
   */
  deferredPlanEffortIntent?: {
    model: string
    effort: Exclude<PlanReasoningEffort, 'auto'>
    threadId: string | undefined
  }
  collaborationError?: string
  /** Per-thread error authority; top-level value is the active projection. */
  collaborationErrorByThread: Record<string, string>
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
  /**
   * Per-thread model binding mirror (Plan B per-thread provider routing).
   * Filled from `openThread` (persisted `AgentThread.model`), confirmed
   * selection transactions, and successful sends. `switchThread` restores
   * `selectedModelId` from here so the picker always shows the CURRENT
   * conversation's model, not the last globally selected one. Session cache
   * only — the authoritative binding lives in the main-process DB.
   */
  modelByThread: Record<string, string>
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
  setModelReasoningEffort: (model: string, effort: ModelReasoningEffort) => void
  setSelectedImageChannel: (channelId: string) => void
  /** Compatibility alias used by the existing toggle until its UI task lands. */
  setCollabMode: (kind: CollaborationModeKind) => void
  requestCollabMode: (kind: CollaborationModeKind) => Promise<void>
  setPlanReasoningEffort: (effort: PlanReasoningEffort) => Promise<void>
  invalidateCollaborationCapabilities: () => void
  loadCollaborationCapabilities: (providerId?: string) => Promise<void>
  addAttachment: (attachment: AgentAttachmentInput) => void
  removeAttachment: (attachment: AgentAttachmentInput) => void
  removeAttachmentForReference: (reference: AgentReference) => void
  addPendingReference: (reference: AgentReference) => void
  removePendingReference: (referenceId: string) => void
  clearPendingReferences: () => void
  /** Mark that the user just opened the canvas; rides the next turn as context. */
  notifyCanvasOpened: () => void
  /**
   * 视频工作台一个渲染批次全部落终态时的推送入口（由 batchCompletion watcher 调）。
   * 线程在跑 → steer 插进当前 turn，模型当场就知道；线程闲着 → 入队，随下一条
   * 用户消息以隐藏前缀送达。两条路都不新开 turn。
   */
  notifyWorkbenchBatchDone: (text: string, threadId?: string) => void
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
   * Replay a failed send: drops the failed bubble + snapshot, seeds the
   * composer from the snapshot, and re-runs the full `send()` pipeline
   * (skills/mentions resolution included). Whatever the user had drafted in
   * the composer before pressing 重试 is restored afterwards.
   */
  retryFailedMessage: (messageId: string) => Promise<void>
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
  beginImageGeneration: (prompt: string, threadId?: string, mediaKind?: 'image' | 'video' | 'audio') => string
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

  /**
   * Installed-plugin mention candidates (codex `plugin/installed`), refreshed
   * lazily by `MentionInput` mount. Consumed by `send()`/`steer()` to resolve
   * `@token`s into `payload.mentions` and by the `@` popup's plugin group.
   * Empty array is fine — tokens then travel as plain text.
   */
  availablePluginMentions: PluginMentionCandidate[]
  loadAvailablePluginMentions: () => Promise<void>

  bootstrap: () => Promise<void>
  refreshThreadList: () => Promise<void>
  refreshCodexThreadList: () => Promise<void>
  forkCodexThread: (threadId: string) => Promise<void>
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  renameThread: (threadId: string, title: string) => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
  /**
   * Choose whether ONE conversation feeds the cross-session memory store.
   * Returns the outcome instead of throwing so the sidebar menu can show the
   * failure in place. The authoritative value lives on the thread row, so a
   * success refreshes the list rather than patching local state.
   */
  setThreadMemoryMode: (
    threadId: string,
    mode: 'enabled' | 'disabled',
  ) => Promise<{ ok: boolean; error?: string }>
  /**
   * Mirror of the GLOBAL `features.memories` switch, pushed here by
   * AgentChatPanel when it reads session status. `undefined` = not read yet.
   * The sidebar uses it to disable the per-thread toggle, since a per-thread
   * "enabled" is meaningless while memory is off process-wide.
   */
  memoriesGloballyEnabled?: boolean
  setMemoriesGloballyEnabled: (enabled: boolean | undefined) => void
}

export { formatContextApplyError } from './modelRoutingSlice'

function resolveOrdinaryModelSelection(
  state: Pick<
    AgentChatState,
    'selectedModelId' | 'modelReasoningEffortByModel'
  >,
): ReturnType<typeof resolveModelSelection> {
  const effort = Object.prototype.hasOwnProperty.call(
    state.modelReasoningEffortByModel,
    state.selectedModelId,
  )
    ? state.modelReasoningEffortByModel[state.selectedModelId]
    : 'auto'
  return resolveModelSelection(
    state.selectedModelId,
    isModelReasoningEffort(effort) ? effort : 'auto',
  )
}

function resolveModelSelectionForMode(
  state: Pick<
    AgentChatState,
    'selectedModelId' | 'modelReasoningEffortByModel'
  >,
  mode: CollaborationModeKind,
): ReturnType<typeof resolveModelSelection> {
  return mode === 'plan'
    ? resolveModelSelection(state.selectedModelId, 'auto')
    : resolveOrdinaryModelSelection(state)
}

/**
 * Resolve the safe value that may cross the renderer/main boundary.
 * `planReasoningEffort` remains the durable user preference; an explicit
 * value is effective only after current-model Codex capabilities confirm it.
 */
export function selectEffectivePlanReasoningEffort(
  state: Pick<
    AgentChatState,
    | 'selectedModelId'
    | 'planReasoningEffort'
    | 'collaborationCapabilities'
    | 'collaborationCapabilitiesModel'
  >,
): PlanReasoningEffort {
  const preference = state.planReasoningEffort
  if (preference === 'auto') return 'auto'
  const canonicalModel = resolveModelSelection(state.selectedModelId).model
  const capabilities =
    state.collaborationCapabilitiesModel === canonicalModel
      ? state.collaborationCapabilities
      : undefined
  if (
    capabilities?.source !== 'codex'
    || !capabilities.supportedPlanEfforts.includes(preference)
  ) {
    return 'auto'
  }
  return preference
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
        return {
          ...item,
          status: 'answered' as const,
          answer: ABANDONED_CHOICE_ANSWER,
          expired: true,
          endedAt: Date.now(),
        }
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

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

function inferImageMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Rebuild the composer's attachment chips from a persisted user message.
 *
 * Two sources, DB-authoritative with rollout fallback (mirrors the official
 * TUI, which rehydrates history chips from the rollout's `userMessage` echo —
 * `local_images` + `text_elements`, openai/codex PR #9116/#9331):
 *   1. DB `attachment` items — richer metadata (name/mime/size), added first.
 *   2. `codexReconcile.localImages` (the rollout's canonical echo persisted by
 *      `ThreadStore.attachCodexReconcile`) — appended for any path the DB rows
 *      don't already cover, with metadata inferred from the filename. This is
 *      what keeps edit-resend chips alive when DB attachment rows are missing
 *      (e.g. rows written by an older build, or a partial persist).
 */
function attachmentsFromMessage(message: Message): AgentAttachmentInput[] {
  const out: AgentAttachmentInput[] = []
  const seenPaths = new Set<string>()
  for (const item of message.items) {
    if (item.type !== 'attachment') continue
    for (const ref of item.attachments) {
      const path = localPathFromAttachmentUri(ref.uri)
      if (!path) continue
      seenPaths.add(normalizeReferencePath(path))
      out.push({
        name: ref.name,
        mime: ref.mime || 'application/octet-stream',
        size: typeof ref.size === 'number' ? ref.size : 0,
        path,
      })
    }
  }
  for (const item of message.items) {
    const reconcile = item.codexReconcile
    if (!reconcile || !Array.isArray(reconcile.localImages)) continue
    for (const rawPath of reconcile.localImages) {
      if (typeof rawPath !== 'string' || rawPath.length === 0) continue
      const path = rawPath.replace(/\\/g, '/')
      const key = normalizeReferencePath(path)
      if (seenPaths.has(key)) continue
      seenPaths.add(key)
      out.push({
        name: path.split('/').pop() ?? path,
        mime: inferImageMime(path),
        size: 0,
        path,
      })
    }
  }
  return out.map(withComposerAttachmentId)
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
    case 'fileEdit': {
      // codex 在 item/started 就把提议的 changes 全给了(含 diff),直接用 ——
      // 这是最早、最可靠的一份,不依赖任何增量通道。
      const started = Array.isArray(payload.changes) ? (payload.changes as FileChange[]) : []
      if (started.length > 0) {
        return {
          type: 'fileEdit',
          id: itemId,
          startedAt: now,
          changes: started,
          totalAdded: started.reduce((sum, c) => sum + c.added, 0),
          totalRemoved: started.reduce((sum, c) => sum + c.removed, 0),
        }
      }
      // 退化路径:只有 path 时先放一个空 diff 的占位改动,让流式增量有地方落、
      // 卡片也能立刻显示文件名,而不是先空白一段再整块弹出。
      const path = typeof payload.path === 'string' && payload.path.length > 0 ? payload.path : null
      return {
        type: 'fileEdit',
        id: itemId,
        startedAt: now,
        changes: path ? [{ path, operation: 'edit', diff: '', added: 0, removed: 0 }] : [],
        totalAdded: 0,
        totalRemoved: 0,
      }
    }
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
    if (field === 'diff' && item.type === 'fileEdit') {
      return appendStreamedDiff(item, text)
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
      if (event.patch.kind === 'mergeFields') {
        // Streaming text always targets the live turn, but field merges can be
        // late reports from a sub-agent that outlived it — keep those on the
        // card they belong to instead of opening a stray one further down.
        const patched = patchExistingItem(slice.messages, itemId, (item) =>
          applyItemPatch(item, event.patch),
        )
        if (patched) return { ...slice, messages: patched }
      }
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
  ...createModelRoutingSlice(set, get, {
    initialSelectedModelId: restoredModelSettings.selectedModelId,
  }),
  isOpen: false,
  input: '',
  attachments: [],
  pendingReferences: [],
  pendingCanvasContext: null,
  pendingWorkbenchNoticesByThread: {},
  pendingApprovals: [],
  failedSendSnapshots: {},
  notices: [],
  goalByThread: {},
  rewoundTurns: [],
  editBranchPending: false,
  messages: [],
  isRunning: false,
  threadSlices: {},
  runningByThread: {},
  modelByThread: {},
  chatScrollByThread: loadChatScrollByThread(),
  modelReasoningEffortByModel:
    restoredModelSettings.modelReasoningEffortByModel,
  modelContextWindowByModel:
    restoredModelSettings.modelContextWindowByModel,
  activeModelContextWindow:
    restoredModelSettings.modelContextWindowByModel[
      restoredModelSettings.selectedModelId
    ]
    ?? defaultContextWindowForModel(restoredModelSettings.selectedModelId),
  modelContextPending: undefined,
  modelSettingsRecoveryRequired: false,
  modelSettingsPersistenceWarnings: restoredModelSettings.persistenceWarnings,
  modelSettingsLoadGeneration: 0,
  modelContextRequestSequence: 0,
  selectedImageChannel: readPersistedImageChannel(),
  collabModeKind: 'default',
  collabModeByThread: restoredThreadCollaborationModes,
  collabModePendingByThread: {},
  collabModeRequestSequence: 0,
  collabModeRequestVersionByThread: {},
  collabModeLifecycleSequence: 0,
  collabModeLifecycleByThread: {},
  collabModeNavigationSequence: 0,
  collabModeCompatibility: 'immediate',
  collabModeCompatibilityByThread: {},
  collabModeRestoredByThread: restoredCollaborationThreads,
  collabModeNextTurnByThread: {},
  planReasoningEffort: readPlanReasoningEffort(),
  collaborationCapabilities: undefined,
  collaborationCapabilitiesModel: undefined,
  collaborationCapabilityRequestSequence: 0,
  deferredPlanEffortIntent: undefined,
  collaborationError: undefined,
  collaborationErrorByThread: {},
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
  availablePluginMentions: [],
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
  setModelReasoningEffort: (model, effort) => {
    if (!isSafeModelSettingsKey(model) || !isModelReasoningEffort(effort)) return
    set((state) => {
      const modelReasoningEffortByModel = {
        ...state.modelReasoningEffortByModel,
        [model]: effort,
      }
      const persisted = persistModelReasoningEfforts(modelReasoningEffortByModel)
      return {
        modelReasoningEffortByModel,
        modelSettingsPersistenceWarnings: updateModelSettingsPersistenceWarning(
          state.modelSettingsPersistenceWarnings,
          'reasoning',
          persisted
            ? undefined
            : 'Reasoning 设置仅本次会话有效，未能持久化。',
        ),
      }
    })
  },
  setSelectedImageChannel: (channelId) => {
    if (!isSelectableImageChannel(channelId)) return
    persistImageChannel(channelId)
    set({ selectedImageChannel: channelId })
  },
  setCollabMode: (kind) => {
    void get().requestCollabMode(kind)
  },
  requestCollabMode: async (kind) => {
    const snapshot = get()
    if (snapshot.isRunning) return
    const threadId = snapshot.threadId
    if (!threadId) {
      set({
        collabModeKind: kind,
        collabModeCompatibility: 'immediate',
        collaborationError: undefined,
      })
      return
    }

    const requestVersion = snapshot.collabModeRequestSequence + 1
    set((state) => {
      const nextTurn = { ...state.collabModeNextTurnByThread }
      delete nextTurn[threadId]
      const errors = { ...state.collaborationErrorByThread }
      delete errors[threadId]
      return {
        collabModeKind: kind,
        collabModePendingByThread: {
          ...state.collabModePendingByThread,
          [threadId]: { target: kind, requestVersion },
        },
        collabModeRequestSequence: requestVersion,
        collabModeRequestVersionByThread: {
          ...state.collabModeRequestVersionByThread,
          [threadId]: requestVersion,
        },
        collabModeNextTurnByThread: nextTurn,
        collaborationErrorByThread: errors,
        ...(state.threadId === threadId ? { collaborationError: undefined } : {}),
      }
    })

    const modelSelection = resolveModelSelectionForMode(snapshot, kind)
    const payload: AgentCollaborationModeUpdatePayload = {
      threadId,
      mode: kind,
      model: modelSelection.model,
      ...(modelSelection.reasoningEffort
        ? { defaultReasoningEffort: modelSelection.reasoningEffort }
        : {}),
      planReasoningEffort: selectEffectivePlanReasoningEffort(get()),
      requestVersion,
    }
    // Always ask Manager, even when the prior result was next-turn. Manager's
    // backend-epoch cache is authoritative and is reset after a Codex restart;
    // renderer compatibility is presentation state only.
    let result: AgentCollaborationModeUpdateResult
    const update = getAgentApi()?.updateCollaborationMode
    if (!update) {
      result = {
        ok: false,
        error: 'Electron collaboration settings API is unavailable',
        requestVersion,
      }
    } else {
      try {
        result = await update(payload)
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          requestVersion,
        }
      }
    }

    set((state) => {
      const pending = state.collabModePendingByThread[threadId]
      const resultVersion = result.ok
        ? result.data.requestVersion
        : result.requestVersion
      if (
        !pending
        || pending.requestVersion !== requestVersion
        || resultVersion !== requestVersion
      ) {
        return {}
      }

      if (!result.ok) {
        const nextPending = { ...state.collabModePendingByThread }
        delete nextPending[threadId]
        const collaborationError = `协作模式更新失败：${result.error}`
        return {
          collabModePendingByThread: nextPending,
          collaborationErrorByThread: {
            ...state.collaborationErrorByThread,
            [threadId]: collaborationError,
          },
          ...(state.threadId === threadId
            ? {
                collabModeKind: state.collabModeByThread[threadId] ?? 'default',
                collaborationError,
              }
            : {}),
        }
      }

      if (result.data.compatibility === 'next-turn') {
        const nextPending = { ...state.collabModePendingByThread }
        delete nextPending[threadId]
        const errors = { ...state.collaborationErrorByThread }
        delete errors[threadId]
        return {
          collabModePendingByThread: nextPending,
          collabModeNextTurnByThread: {
            ...state.collabModeNextTurnByThread,
            [threadId]: pending.target,
          },
          collabModeCompatibilityByThread: {
            ...state.collabModeCompatibilityByThread,
            [threadId]: 'next-turn',
          },
          collaborationErrorByThread: errors,
          ...(state.threadId === threadId
            ? {
                collabModeCompatibility: 'next-turn',
                collaborationError: undefined,
              }
            : {}),
        }
      }

      // A successful update may be a no-op, in which case Codex deliberately
      // emits no thread/settings/updated notification. Settle the request from
      // the RPC acknowledgement; any later notification still reconciles the
      // authoritative server value through applyEvent.
      const nextPending = { ...state.collabModePendingByThread }
      delete nextPending[threadId]
      const confirmed = { ...state.collabModeByThread }
      delete confirmed[threadId]
      confirmed[threadId] = pending.target
      persistThreadCollaborationModes(confirmed)
      const nextRestored = { ...state.collabModeRestoredByThread }
      delete nextRestored[threadId]
      const nextTurn = { ...state.collabModeNextTurnByThread }
      delete nextTurn[threadId]
      const errors = { ...state.collaborationErrorByThread }
      delete errors[threadId]
      return {
        collabModeByThread: confirmed,
        collabModePendingByThread: nextPending,
        collabModeRestoredByThread: nextRestored,
        collabModeNextTurnByThread: nextTurn,
        collabModeCompatibilityByThread: {
          ...state.collabModeCompatibilityByThread,
          [threadId]: 'immediate',
        },
        collaborationErrorByThread: errors,
        ...(state.threadId === threadId
          ? {
              collabModeKind: pending.target,
              collabModeCompatibility: 'immediate',
              collaborationError: undefined,
            }
          : {}),
      }
    })
  },
  setPlanReasoningEffort: async (effort) => {
    const before = get()
    const canonicalModel = resolveModelSelection(before.selectedModelId).model
    const capabilities =
      before.collaborationCapabilitiesModel === canonicalModel
        ? before.collaborationCapabilities
        : undefined
    const normalised =
      effort !== 'auto'
      && capabilities?.source === 'codex'
      && !capabilities.supportedPlanEfforts.includes(effort)
        ? 'auto'
        : effort
    const shouldDefer =
      capabilities?.source !== 'codex'
      && normalised !== 'auto'
      && before.collabModeKind === 'plan'
      && before.threadId !== undefined
      && !before.isRunning
    persistPlanReasoningEffort(normalised)
    set((state) => {
      const errors = { ...state.collaborationErrorByThread }
      if (before.threadId) delete errors[before.threadId]
      return {
        planReasoningEffort: normalised,
        deferredPlanEffortIntent: shouldDefer
          ? { model: canonicalModel, effort: normalised, threadId: before.threadId }
          : undefined,
        collaborationErrorByThread: errors,
        ...(state.threadId === before.threadId ? { collaborationError: undefined } : {}),
      }
    })

    const state = get()
    if (
      state.collabModeKind === 'plan'
      && state.threadId
      && !state.isRunning
      && capabilities?.source === 'codex'
    ) {
      await state.requestCollabMode('plan')
    }
  },
  invalidateCollaborationCapabilities: () => {
    cancelQueuedModelContextIntent()
    set((state) => ({
      collaborationCapabilities: undefined,
      collaborationCapabilitiesModel: undefined,
      collaborationCapabilityRequestSequence:
        state.collaborationCapabilityRequestSequence + 1,
      deferredPlanEffortIntent: undefined,
      modelSettingsCatalog: undefined,
      modelSettingsLoading: false,
      ...(state.modelSettingsRecoveryRequired
        ? {}
        : { modelSettingsError: undefined }),
      modelContextPending: undefined,
      modelSettingsLoadGeneration: state.modelSettingsLoadGeneration + 1,
    }))
  },
  loadCollaborationCapabilities: async (providerId) => {
    void get().loadModelSettingsCatalog(providerId)
    let owner = get()
    const capabilityRequestSequence =
      owner.collaborationCapabilityRequestSequence + 1
    set({ collaborationCapabilityRequestSequence: capabilityRequestSequence })
    owner = get()
    const model = resolveModelSelection(owner.selectedModelId).model
    const ownerThreadId = owner.threadId
    if (
      ownerThreadId !== undefined
      && owner.collabModeLifecycleByThread[ownerThreadId] === undefined
    ) {
      const generation = owner.collabModeLifecycleSequence + 1
      set({
        collabModeLifecycleSequence: generation,
        collabModeLifecycleByThread: withBoundedLifecycleGeneration(
          owner.collabModeLifecycleByThread,
          ownerThreadId,
          generation,
        ),
      })
      owner = get()
    }
    const ownerLifecycleGeneration =
      ownerThreadId === undefined
        ? undefined
        : owner.collabModeLifecycleByThread[ownerThreadId]
    const isCapabilityRequestCurrent = (): boolean =>
      get().collaborationCapabilityRequestSequence === capabilityRequestSequence
    const isOwnerLifecycleCurrent = (): boolean => {
      if (ownerThreadId === undefined) return true
      if (ownerLifecycleGeneration === undefined) return false
      if (deletedCollaborationThreadTombstones.has(ownerThreadId)) return false
      return get().collabModeLifecycleByThread[ownerThreadId] === ownerLifecycleGeneration
    }
    const applyFallback = (error?: string): void => {
      if (!isCapabilityRequestCurrent()) return
      if (resolveModelSelection(get().selectedModelId).model !== model) return
      if (!isOwnerLifecycleCurrent()) return
      set((state) => {
        const hasKnownCodexCapabilities =
          state.collaborationCapabilitiesModel === model
          && state.collaborationCapabilities?.source === 'codex'
          && (
            providerId === undefined
            || capabilitiesOwnerGatewayId(state.collaborationCapabilities) === providerId
          )
        const errors = { ...state.collaborationErrorByThread }
        if (ownerThreadId) {
          if (error) errors[ownerThreadId] = error
          else delete errors[ownerThreadId]
        }
        const shouldDefer =
          !hasKnownCodexCapabilities
          && state.planReasoningEffort !== 'auto'
          && ownerThreadId !== undefined
          && state.threadId === ownerThreadId
          && state.collabModeKind === 'plan'
          && !state.isRunning
        return {
          ...(hasKnownCodexCapabilities
            ? {}
            : {
                collaborationCapabilities: fallbackCollaborationCapabilities(
                  providerId ?? state.collaborationCapabilities?.providerId ?? 'unknown',
                ),
                collaborationCapabilitiesModel: model,
              }),
          ...(shouldDefer
            ? {
                deferredPlanEffortIntent: {
                  model,
                  effort: state.planReasoningEffort as Exclude<PlanReasoningEffort, 'auto'>,
                  threadId: ownerThreadId,
                },
              }
            : {}),
          collaborationErrorByThread: errors,
          ...(state.threadId === ownerThreadId ? { collaborationError: error } : {}),
        }
      })
    }
    const agent = getAgentApi()
    if (!agent?.getCollaborationCapabilities) {
      applyFallback('协作能力暂不可用，已安全回退为 Auto。')
      return
    }
    try {
      const result = await agent.getCollaborationCapabilities(model)
      if (!isCapabilityRequestCurrent()) return
      if (!isOwnerLifecycleCurrent()) return
      if (!result.ok) {
        applyFallback('协作能力暂不可用，已安全回退为 Auto。')
        return
      }
      if (resolveModelSelection(get().selectedModelId).model !== model) return
      if (
        providerId !== undefined
        && capabilitiesOwnerGatewayId(result.data) !== providerId
      ) return
      if (result.data.source !== 'codex') {
        applyFallback()
        return
      }

      const state = get()
      const preference = state.planReasoningEffort
      const unsupported =
        preference !== 'auto'
        && !result.data.supportedPlanEfforts.includes(preference)
      const deferred = state.deferredPlanEffortIntent
      const shouldSubmitDeferred =
        !unsupported
        && deferred?.model === model
        && deferred.effort === preference
        && result.data.supportedPlanEfforts.includes(deferred.effort)
        && state.collabModeKind === 'plan'
        && state.threadId !== undefined
        && state.threadId === deferred.threadId
        && !state.isRunning

      const errors = { ...state.collaborationErrorByThread }
      if (ownerThreadId) delete errors[ownerThreadId]
      set({
        collaborationCapabilities: result.data,
        collaborationCapabilitiesModel: model,
        collaborationErrorByThread: errors,
        ...(get().threadId === ownerThreadId ? { collaborationError: undefined } : {}),
        ...(deferred ? { deferredPlanEffortIntent: undefined } : {}),
        ...(unsupported ? { planReasoningEffort: 'auto' as const } : {}),
      })

      if (unsupported) {
        persistPlanReasoningEffort('auto')
        get().pushNotice({
          id: 'collaboration-plan-effort-reset',
          kind: 'configWarning',
          level: 'info',
          message: '当前模型不支持已保存的 Plan 推理强度，已恢复为 Auto。',
        })
        return
      }

      if (shouldSubmitDeferred) {
        await get().requestCollabMode('plan')
      }
    } catch {
      // Capabilities are optional metadata; degrade without touching chat flow.
      if (!isCapabilityRequestCurrent()) return
      if (!isOwnerLifecycleCurrent()) return
      applyFallback('协作能力暂不可用，已安全回退为 Auto。')
    }
  },
  addAttachment: (attachment) =>
    set((state) => ({
      attachments: [...state.attachments, withComposerAttachmentId(attachment)],
    })),
  removeAttachment: (attachment) =>
    set((state) => ({
      attachments: state.attachments.filter((item) =>
        attachment.composerId
          ? item.composerId !== attachment.composerId
          : item !== attachment,
      ),
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
  notifyWorkbenchBatchDone: (text, threadId) => {
    const state = get()
    const target = threadId ?? state.threadId
    // 没有线程可归属（从未开过聊天）：这条通知没有收件人，丢掉。用户在工作台
    // 页面上照样看得到结果。
    if (!target) return

    // 该线程正在跑 → 直接 steer 插进当前 turn。刻意绕开 store 的 steer()：
    // 那条路会把 state.input（用户草稿）变成一条真实用户气泡，而这是系统通知，
    // 不该伪造成用户说的话，也不该吃掉他正在打的字。
    if (state.runningByThread[target]) {
      const steer = getAgentApi()?.steer
      if (steer) {
        void steer({
          threadId: target,
          content: text,
          attachments: [],
          references: [],
          currentPage: window.location.hash.slice(1),
        }).catch(() => {
          // turn 刚好在这一瞬结束（steer 竞态）→ 退回排队，等下一条消息带走。
          set((current) => ({
            pendingWorkbenchNoticesByThread: {
              ...current.pendingWorkbenchNoticesByThread,
              [target]: [...(current.pendingWorkbenchNoticesByThread[target] ?? []), text],
            },
          }))
        })
        return
      }
    }

    set((current) => ({
      pendingWorkbenchNoticesByThread: {
        ...current.pendingWorkbenchNoticesByThread,
        [target]: [...(current.pendingWorkbenchNoticesByThread[target] ?? []), text],
      },
    }))
  },
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
    const getGoal = getAgentApi()?.getGoal
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
    const setGoalApi = getAgentApi()?.setGoal
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
    const setGoalApi = getAgentApi()?.setGoal
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
    const setGoalApi = getAgentApi()?.setGoal
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
    const clearGoalApi = getAgentApi()?.clearGoal
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
    const compactApi = getAgentApi()?.compactThread
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
    if (!agent?.respondApproval) {
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
    // 同款隐藏前缀：turn 结束后跑完的视频工作台批次在这里排队等车。刻意不自己开
    // turn（省 token、不打扰），所以只有用户真的说下一句话时才随车送达。
    const workbenchNotices = state.threadId
      ? state.pendingWorkbenchNoticesByThread[state.threadId] ?? []
      : []
    if (state.isRunning) return
    // A model-selection transaction may be restarting the backend Channel;
    // sending mid-transaction could route to the wrong Gateway/Channel.
    if (state.modelSelectionPending !== undefined) return
    if (!content && attachments.length === 0 && references.length === 0) return

    const modelSelection = resolveModelSelectionForMode(
      state,
      state.collabModeKind,
    )
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
    const userMsg: Message = {
      id: createId(),
      role: 'user',
      createdAt: now,
      items,
      // Delivery indicator (batch 3-A): flips to 'sent' once main admits the
      // turn, or 'failed' (bubble stays with a retry button) on IPC rejection.
      sendState: 'sending',
    }

    set((current) => ({
      input: '',
      attachments: [],
      pendingCanvasContext: null,
      // 已上车的通知出队。发送失败时在下面的 catch 里原样退回，不会丢。
      ...(workbenchNotices.length > 0 && state.threadId
        ? {
            pendingWorkbenchNoticesByThread: {
              ...current.pendingWorkbenchNoticesByThread,
              [state.threadId]: (current.pendingWorkbenchNoticesByThread[state.threadId] ?? [])
                .slice(workbenchNotices.length),
            },
          }
        : {}),
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
    // `@plugin` tokens → mention items with exact plugin:// paths, so codex
    // activates the installed plugin instead of guessing by name.
    const mentions = resolveMentions(content, state.availablePluginMentions)

    try {
      const sendMessage = getAgentApi()?.sendMessage
      if (!sendMessage) throw new Error('Electron agent API is unavailable')
      const result = await sendMessage({
        threadId: state.threadId,
        content: [...(canvasContext ? [canvasContext] : []), ...workbenchNotices, content]
          .filter((part) => part.length > 0)
          .join('\n\n'),
        attachments,
        references,
        currentPage: window.location.hash.slice(1),
        ...modelSelection,
        skills: skills.length > 0 ? skills : undefined,
        mentions,
        collaborationModeKind: state.collabModeKind,
        planReasoningEffort: selectEffectivePlanReasoningEffort(state),
      })
      const wasNewThread = state.threadId == null
      // Only a new-thread send proves this id belongs to a new lifecycle.
      // A late response from an existing thread deleted in-flight must not.
      if (wasNewThread) clearDeletedThreadTombstone(result.threadId)
      set((current) => {
        const compatibility =
          current.collabModeCompatibilityByThread[result.threadId] ?? 'immediate'
        const collaborationError = current.collaborationErrorByThread[result.threadId]
        const base = {
          threadId: result.threadId,
          runningByThread: { ...current.runningByThread, [result.threadId]: true },
          // Per-thread model mirror (Plan B): this send just ran (and, for a
          // new thread, bound) the resolved model on this conversation.
          modelByThread: {
            ...current.modelByThread,
            [result.threadId]: modelSelection.model,
          },
          ...(wasNewThread
            ? {
                collabModeCompatibilityByThread: {
                  ...current.collabModeCompatibilityByThread,
                  [result.threadId]: compatibility,
                },
                collabModeCompatibility: compatibility,
                collaborationError,
              }
            : {}),
        }
        if (!wasNewThread) return base

        // A thread_settings_updated notification can beat the IPC response.
        // Persisted restart entries also live in collabModeByThread, so map
        // presence alone is insufficient: only an entry whose restored marker
        // has been cleared is confirmed by this process.
        const confirmedInThisProcess =
          Object.prototype.hasOwnProperty.call(current.collabModeByThread, result.threadId)
          && current.collabModeRestoredByThread[result.threadId] !== true
        if (confirmedInThisProcess) {
          const nextTurn = { ...current.collabModeNextTurnByThread }
          delete nextTurn[result.threadId]
          const nextPending = { ...current.collabModePendingByThread }
          delete nextPending[result.threadId]
          return {
            ...base,
            collabModeKind: current.collabModeByThread[result.threadId],
            collabModeNextTurnByThread: nextTurn,
            collabModePendingByThread: nextPending,
          }
        }

        // No live confirmation yet: retain exactly the draft submitted on this
        // first send, but do not promote it to server-confirmed state.
        return {
          ...base,
          collabModeNextTurnByThread: {
            ...current.collabModeNextTurnByThread,
            [result.threadId]: state.collabModeKind,
          },
        }
      })
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
      {
        const canonicalItems =
          result.userMessageItems && result.userMessageItems.length > 0
            ? result.userMessageItems
            : undefined
        // Also settle the delivery indicator: main admitted the turn, so the
        // bubble flips from "发送中" to "已送达" in the same pass.
        set((current) => ({
          messages: current.messages.map((m) =>
            m.id === userMsg.id
              ? {
                  ...m,
                  sendState: 'sent' as const,
                  ...(canonicalItems ? { items: canonicalItems } : {}),
                  // Backfill the persisted row id so a later edit-and-resend
                  // can hand the context-branch API a real DB row id.
                  ...(result.userMessageId ? { dbRowId: result.userMessageId } : {}),
                }
              : m,
          ),
        }))
      }
      // PHASE-1-INVARIANT: pendingReferences are renderer-only chips. Do not
      // add them to AgentSendMessagePayload until the Phase 2 payload contract lands.
      get().clearPendingReferences()
      void useFileExplorerStore.getState().refreshAttachmentsTree().catch(() => undefined)
    } catch (error) {
      // Cursor-style failure UX (batch 3-A): the bubble STAYS in the timeline
      // marked failed (red badge + 重试), instead of silently vanishing with
      // the text dumped back into the composer. The exact composer state is
      // snapshotted so retry replays it through the full send() pipeline.
      set((current) => {
        const runningByThread = { ...current.runningByThread }
        if (state.threadId) delete runningByThread[state.threadId]
        return {
          isRunning: false,
          error: error instanceof Error ? error.message : String(error),
          // The reference chips now belong to the failed bubble's snapshot;
          // leaving them in the composer would double-attach them if the user
          // typed a fresh message before retrying.
          pendingReferences: [],
          messages: current.messages.map((m) =>
            m.id === userMsg.id ? { ...m, sendState: 'failed' as const } : m,
          ),
          failedSendSnapshots: {
            ...current.failedSendSnapshots,
            [userMsg.id]: {
              content,
              attachments,
              references: state.pendingReferences,
              canvasContext,
            },
          },
          // 这一车没发出去，工作台通知退回队首等下一趟。它跟 canvasContext 不同，
          // 不进 failedSendSnapshot —— 通知的生命周期独立于「用户是否点重试」。
          ...(workbenchNotices.length > 0 && state.threadId
            ? {
                pendingWorkbenchNoticesByThread: {
                  ...current.pendingWorkbenchNoticesByThread,
                  [state.threadId]: [
                    ...workbenchNotices,
                    ...(current.pendingWorkbenchNoticesByThread[state.threadId] ?? []),
                  ],
                },
              }
            : {}),
          runningByThread,
        }
      })
    }
  },
  retryFailedMessage: async (messageId) => {
    const state = get()
    if (state.isRunning) return
    const snapshot = state.failedSendSnapshots[messageId]
    if (!snapshot) return
    // Preserve whatever the user was drafting before pressing 重试.
    const draft = {
      input: state.input,
      attachments: state.attachments,
      pendingReferences: state.pendingReferences,
    }
    set((current) => {
      const nextSnapshots = { ...current.failedSendSnapshots }
      delete nextSnapshots[messageId]
      return {
        failedSendSnapshots: nextSnapshots,
        messages: current.messages.filter((m) => m.id !== messageId),
        input: snapshot.content,
        attachments: snapshot.attachments,
        pendingReferences: snapshot.references,
        pendingCanvasContext: snapshot.canvasContext,
        error: undefined,
      }
    })
    await get().send()
    set({
      input: draft.input,
      attachments: draft.attachments,
      pendingReferences: draft.pendingReferences,
    })
  },
  steer: async () => {
    const state = get()
    const content = state.input.trim()
    const attachments = state.attachments
    const references = state.pendingReferences
    // Mirror send(): never inject input while a model-selection transaction
    // may be restarting the backend Channel.
    if (state.modelSelectionPending !== undefined) return
    // Steering only makes sense mid-turn on an existing thread. If nothing is
    // running, defer to a normal send so a stray call never silently drops input.
    if (!state.isRunning || !state.threadId) {
      await get().send()
      return
    }
    if (!content && attachments.length === 0 && references.length === 0) return
    const steer = getAgentApi()?.steer
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
    const mentions = resolveMentions(content, state.availablePluginMentions)

    try {
      const modelSelection = resolveModelSelectionForMode(
        state,
        state.collabModeKind,
      )
      const result = await steer({
        threadId,
        content,
        attachments,
        references,
        currentPage: window.location.hash.slice(1),
        ...modelSelection,
        skills: skills.length > 0 ? skills : undefined,
        mentions,
        // AgentManager keeps these on the assembled input for its no-active-turn
        // fresh-turn fallback; CodexProtocolClient deliberately omits them from
        // a genuine upstream turn/steer request.
        collaborationModeKind: state.collabModeKind,
        planReasoningEffort: selectEffectivePlanReasoningEffort(state),
      })
      if (result.userMessageItems && result.userMessageItems.length > 0) {
        const canonicalItems = result.userMessageItems
        set((current) => ({
          messages: current.messages.map((m) =>
            m.id === userMsg.id
              ? {
                  ...m,
                  items: canonicalItems,
                  ...(result.userMessageId ? { dbRowId: result.userMessageId } : {}),
                }
              : m,
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
    if (!editingId || state.isRunning || state.editBranchPending) return

    const idx = state.messages.findIndex((m) => m.id === editingId)
    if (idx === -1) {
      // Stale edit target — bail out cleanly.
      set({ editingMessageId: undefined, draftBackup: undefined })
      return
    }

    // Server-side context branch (codex 0.145 thread/fork + lastTurnId):
    // ask main to fork the codex thread BEFORE the edited message's turn and
    // to truncate the DB rows at/after the edit point, so the model actually
    // forgets the dropped turns instead of only the UI forgetting them.
    // Every failure degrades to today's same-thread resend — main emits an
    // `editBranchDegraded` warning notice where appropriate, so this path
    // never blocks the edit itself.
    const threadId = state.threadId
    const target = state.messages[idx]
    const branchApi = getAgentApi()?.branchThreadBeforeMessage
    if (threadId && branchApi) {
      set({ editBranchPending: true })
      try {
        // Live-session bubbles carry the persisted row id in `dbRowId`
        // (backfilled from send()); DB-reloaded messages' `id` IS the row id.
        await branchApi(threadId, target.dbRowId ?? target.id)
      } catch {
        // IPC/transport failure — silent degrade to same-thread resend.
      } finally {
        set({ editBranchPending: false })
      }
    }

    // Re-read state after the await: the branch RPC yielded the event loop,
    // so truncate against the CURRENT timeline instead of a stale snapshot.
    const current = get()
    const currentIdx = current.messages.findIndex((m) => m.id === editingId)
    set({
      messages: currentIdx === -1 ? current.messages : current.messages.slice(0, currentIdx),
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
      const cancel = getAgentApi()?.cancel
      if (!cancel) throw new Error('Electron agent API is unavailable')
      await cancel({ threadId })
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
        deferredPlanEffortIntent: undefined,
        // An empty composer is also a navigation target; invalidate any
        // openThread promise that was started before this user action.
        collabModeNavigationSequence: current.collabModeNavigationSequence + 1,
        collabModeCompatibility: 'immediate',
        collaborationError: undefined,
      }
    }),
  switchThread: async (threadId: string) => {
    const initial = get()
    const navigationToken = initial.collabModeNavigationSequence + 1
    if (initial.threadId === threadId) {
      set({ collabModeNavigationSequence: navigationToken })
      return
    }
    const wasTombstoned = deletedCollaborationThreadTombstones.has(threadId)
    const expectedTombstoneGeneration = wasTombstoned
      ? deletedCollaborationThreadTombstones.get(threadId)
      : undefined
    const existingGeneration = initial.collabModeLifecycleByThread[threadId]
    const startsNewLifecycle = wasTombstoned || existingGeneration === undefined
    const lifecycleGeneration = startsNewLifecycle
      ? initial.collabModeLifecycleSequence + 1
      : existingGeneration
    // The user has left the intent's owner thread. Invalidate immediately,
    // before a potentially async openThread, so a capabilities response cannot
    // submit thread A settings while navigation to thread B is in flight.
    set({
      deferredPlanEffortIntent: undefined,
      collabModeNavigationSequence: navigationToken,
      ...(startsNewLifecycle
        ? {
            collabModeLifecycleSequence: lifecycleGeneration,
            collabModeLifecycleByThread: withBoundedLifecycleGeneration(
              initial.collabModeLifecycleByThread,
              threadId,
              lifecycleGeneration,
            ),
          }
        : {}),
    })
    const isNavigationCurrent = (): boolean => {
      const state = get()
      return (
        state.collabModeNavigationSequence === navigationToken
        && state.collabModeLifecycleByThread[threadId] === lifecycleGeneration
        && (
          wasTombstoned
            ? deletedCollaborationThreadTombstones.get(threadId)
              === expectedTombstoneGeneration
            : !deletedCollaborationThreadTombstones.has(threadId)
        )
      )
    }

    // Prefer the live background slice (a chat that streamed while we were
    // viewing another one) — it's fresher than the persisted server snapshot.
    let restored: ThreadSlice | null =
      wasTombstoned ? null : get().threadSlices[threadId] ?? null
    // Persisted per-thread model binding (Plan B). Fresh openThread reads win;
    // live-slice restores fall back to the session mirror in the commit below.
    let threadModel: string | undefined

    if (!restored) {
      const agent = getAgentApi()
      if (!agent?.openThread) return
      let thread: unknown
      try {
        thread = await agent.openThread(threadId)
      } catch (error) {
        throw error
      }
      if (!isNavigationCurrent()) return
      if (!thread || typeof thread !== 'object') return

      const rawModel = (thread as { model?: unknown }).model
      if (typeof rawModel === 'string' && rawModel.length > 0) {
        threadModel = rawModel
      }

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

    if (!isNavigationCurrent()) return
    // Commit atomically: snapshot the OUTGOING active view into its background
    // slice (so its in-flight turn keeps streaming there), drop the incoming
    // thread from the background map (it's the active view now), and install it.
    // For explicit reopen, validation and tombstone clearing happen in this
    // same synchronous state transition; stale/failed opens never clear it.
    const modelBeforeCommit = get().selectedModelId
    set((cur) => {
      if (
        cur.collabModeNavigationSequence !== navigationToken
        || cur.collabModeLifecycleByThread[threadId] !== lifecycleGeneration
        || (
          wasTombstoned
            ? deletedCollaborationThreadTombstones.get(threadId)
              !== expectedTombstoneGeneration
            : deletedCollaborationThreadTombstones.has(threadId)
        )
      ) {
        return {}
      }
      if (wasTombstoned) clearDeletedThreadTombstone(threadId)
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
      // Per-thread model display (Plan B): the picker follows the INCOMING
      // conversation's own bound model. Fresh openThread reads refresh the
      // session mirror; live-slice restores read the mirror. A bound model the
      // current catalog cannot serve is NOT adopted (main's send path falls
      // back to the global selection for those too), and an in-flight
      // selection transaction keeps ownership of `selectedModelId`.
      const boundModel = threadModel ?? cur.modelByThread[threadId]
      const adoptModel =
        boundModel !== undefined
        && boundModel !== cur.selectedModelId
        && cur.modelSelectionPending === undefined
        && cur.modelSettingsCatalog?.models.some(
          (row) => row.id === boundModel,
        ) === true
      return {
        threadId,
        threadSlices,
        ...(threadModel !== undefined
          ? { modelByThread: { ...cur.modelByThread, [threadId]: threadModel } }
          : {}),
        ...(adoptModel ? { selectedModelId: boundModel } : {}),
        messages: restored!.messages,
        isRunning: restored!.isRunning,
        tokenUsage: restored!.tokenUsage,
        error: restored!.error,
        pendingApprovals: [],
        collabModeKind:
          cur.collabModePendingByThread[threadId]?.target
          ?? cur.collabModeNextTurnByThread[threadId]
          ?? cur.collabModeByThread[threadId]
          ?? 'default',
        collabModeCompatibility:
          cur.collabModeCompatibilityByThread[threadId] ?? 'immediate',
        collaborationError: cur.collaborationErrorByThread[threadId],
      }
    })
    // Re-own capability surfaces (Plan effort options etc.) for the adopted
    // per-thread model. No-op when the incoming thread rides the same model.
    if (
      get().threadId === threadId
      && get().selectedModelId !== modelBeforeCommit
    ) {
      void get().loadCollaborationCapabilities()
    }
  },
  applyEvent: (event) => {
    if (event.type === 'thread_settings_updated') {
      if (deletedCollaborationThreadTombstones.has(event.threadId)) return
      const before = get()
      const pending = before.collabModePendingByThread[event.threadId]
      const previous = before.collabModeByThread[event.threadId]
      const matchingPending = pending?.target === event.mode
      const matchingNextTurn =
        before.collabModeNextTurnByThread[event.threadId] === event.mode
      const shouldNotice =
        !matchingPending
        && !matchingNextTurn
        && previous !== undefined
        && previous !== event.mode

      set((state) => {
        // Reinsert the key so persistence order tracks the latest confirmation.
        const confirmed = { ...state.collabModeByThread }
        delete confirmed[event.threadId]
        confirmed[event.threadId] = event.mode
        persistThreadCollaborationModes(confirmed)

        const nextPending = { ...state.collabModePendingByThread }
        if (matchingPending) delete nextPending[event.threadId]
        const nextRestored = { ...state.collabModeRestoredByThread }
        delete nextRestored[event.threadId]
        const nextTurn = { ...state.collabModeNextTurnByThread }
        const nextTurnTarget = nextTurn[event.threadId]
        const matchingNextTurn = nextTurnTarget === event.mode
        if (matchingNextTurn) delete nextTurn[event.threadId]
        const remainingTarget =
          nextPending[event.threadId]?.target
          ?? nextTurn[event.threadId]
          ?? event.mode
        const compatibility: CollabModeCompatibility =
          nextTurnTarget !== undefined && !matchingNextTurn
            ? state.collabModeCompatibilityByThread[event.threadId] ?? 'next-turn'
            : 'immediate'
        const compatibilityByThread = {
          ...state.collabModeCompatibilityByThread,
          [event.threadId]: compatibility,
        }
        const errors = { ...state.collaborationErrorByThread }
        if (matchingPending || matchingNextTurn) delete errors[event.threadId]
        const isActiveThread = state.threadId === event.threadId

        return {
          collabModeByThread: confirmed,
          collabModePendingByThread: nextPending,
          collabModeRestoredByThread: nextRestored,
          collabModeNextTurnByThread: nextTurn,
          collabModeCompatibilityByThread: compatibilityByThread,
          collaborationErrorByThread: errors,
          ...(isActiveThread
            ? {
                collabModeKind: remainingTarget,
                collabModeCompatibility: compatibility,
              }
            : {}),
          ...(isActiveThread && (matchingPending || matchingNextTurn)
            ? { collaborationError: undefined }
            : {}),
        }
      })

      if (shouldNotice) {
        get().pushNotice({
          id: `collaboration-server-override:${event.threadId}:${event.mode}`,
          kind: 'configWarning',
          level: 'info',
          threadId: event.threadId,
          message: `服务器已确认 ${event.mode === 'plan' ? 'Plan' : 'Default'} 模式。`,
        })
      }
      return
    }

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
      // The turn is over — any still-pending ask_user card in this thread can
      // never deliver its answer (its blocked tool call has already returned
      // via timeout / error / cancel). Freeze it as expired so the user isn't
      // left with a clickable-but-dead button (the "过一段时间再点就卡住"
      // bug), and resolve the renderer-side ask() promise so the executor's
      // await doesn't leak. Normal turns are unaffected: while a card is
      // pending the turn is blocked on the tool call, so a terminal event with
      // a pending card is by definition an orphan.
      if (evtId) {
        const expiredIds: string[] = []
        set((s) => {
          if (s.threadId === evtId) {
            const r = expirePendingChoices(s.messages)
            expiredIds.push(...r.ids)
            return r.messages === s.messages ? {} : { messages: r.messages }
          }
          const slice = s.threadSlices[evtId]
          if (!slice) return {}
          const r = expirePendingChoices(slice.messages)
          expiredIds.push(...r.ids)
          if (r.messages === slice.messages) return {}
          return {
            threadSlices: {
              ...s.threadSlices,
              [evtId]: { ...slice, messages: r.messages },
            },
          }
        })
        resolveAbandonedChoices(expiredIds)
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
    const agent = getAgentApi()
    if (!agent?.getSkillsSummary) return
    try {
      const summary = await agent.getSkillsSummary()
      set({ availableSkills: summary.skills })
    } catch {
      // Skills are an optional convenience — keep the previous cache rather
      // than burning a banner on the chat panel for a transient IPC failure.
    }
  },

  loadAvailablePluginMentions: async () => {
    const agent = getAgentApi()
    if (!agent?.listInstalledPlugins) return
    try {
      const result = await agent.listInstalledPlugins()
      if (!result.ok || !result.data) return
      set({ availablePluginMentions: pluginMentionCandidates(result.data) })
    } catch {
      // Same policy as loadAvailableSkills: mentions are a convenience —
      // keep the previous cache on transient IPC failure.
    }
  },

  bootstrap: async () => {
    if (get().bootstrapped || get().threadListLoading) return
    set({ threadListLoading: true })
    void get().loadCollaborationCapabilities()
    const agent = getAgentApi()
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
    const agent = getAgentApi()
    if (!agent?.listThreads) return
    try {
      const list = await agent.listThreads()
      set({ threadList: list })
    } catch {
      /* swallow refresh errors — stale list is preferable to a banner */
    }
  },

  refreshCodexThreadList: async () => {
    const agent = getAgentApi()
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
    const agent = getAgentApi()
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
    const agent = getAgentApi()
    if (!agent?.renameThread) return
    await agent.renameThread(threadId, trimmed)
    await get().refreshThreadList()
  },

  setMemoriesGloballyEnabled: (enabled) => set({ memoriesGloballyEnabled: enabled }),

  setThreadMemoryMode: async (threadId, mode) => {
    if (!threadId) return { ok: false, error: '会话尚未创建' }
    const agent = getAgentApi()
    if (!agent?.declareThreadMemoryMode) {
      return { ok: false, error: '当前版本不支持按会话记忆开关' }
    }
    try {
      const res = await agent.declareThreadMemoryMode(threadId, mode)
      if (!res?.ok) return { ok: false, error: res?.error ?? '设置失败' }
      await get().refreshThreadList()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  deleteThread: async (threadId) => {
    const agent = getAgentApi()
    if (!agent?.deleteThread) return
    await agent.deleteThread(threadId)
    const lifecycleGeneration = get().collabModeLifecycleSequence + 1
    addDeletedThreadTombstone(threadId, lifecycleGeneration)
    // Unblock any pending ask_user cards owned by the deleted thread (active view
    // OR a background slice) so their blocked agent calls return instead of
    // leaking a resolver forever.
    const expiredIds: string[] = []
    set((s) => {
      const isActive = s.threadId === threadId
      const msgs = isActive ? s.messages : s.threadSlices[threadId]?.messages
      const expired = msgs ? expirePendingChoices(msgs) : null
      if (expired) expiredIds.push(...expired.ids)

      const collabModeByThread = withoutRecordKey(s.collabModeByThread, threadId)
      persistThreadCollaborationModes(collabModeByThread)
      const collaborationPatch = {
        modelByThread: withoutRecordKey(s.modelByThread, threadId),
        collabModeByThread,
        // Pending/version maps are lifecycle-local and may be cleared. The
        // generation survives delete and explicit reopen, so late async work
        // from the old lifecycle cannot attach to a reused thread id. The map
        // is bounded with the same 200-entry policy as deletion tombstones.
        collabModeLifecycleSequence: lifecycleGeneration,
        collabModeLifecycleByThread: withBoundedLifecycleGeneration(
          s.collabModeLifecycleByThread,
          threadId,
          lifecycleGeneration,
        ),
        collabModePendingByThread: withoutRecordKey(
          s.collabModePendingByThread,
          threadId,
        ),
        collabModeRequestVersionByThread: withoutRecordKey(
          s.collabModeRequestVersionByThread,
          threadId,
        ),
        collabModeRestoredByThread: withoutRecordKey(
          s.collabModeRestoredByThread,
          threadId,
        ),
        collabModeNextTurnByThread: withoutRecordKey(
          s.collabModeNextTurnByThread,
          threadId,
        ),
        collabModeCompatibilityByThread: withoutRecordKey(
          s.collabModeCompatibilityByThread,
          threadId,
        ),
        collaborationErrorByThread: withoutRecordKey(
          s.collaborationErrorByThread,
          threadId,
        ),
      }

      if (!expired || expired.messages === msgs) return collaborationPatch
      if (isActive) return { ...collaborationPatch, messages: expired.messages }
      const slice = s.threadSlices[threadId]
      if (!slice) return collaborationPatch
      return {
        ...collaborationPatch,
        threadSlices: {
          ...s.threadSlices,
          [threadId]: { ...slice, messages: expired.messages },
        },
      }
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
        deferredPlanEffortIntent: undefined,
        collabModeCompatibility: 'immediate',
        collaborationError: undefined,
      })
    }
    await get().refreshThreadList()
  },
}))

export type { AgentChatState }
export type { AgentChatMessage } from './types'
