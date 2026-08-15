import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, dialog, Notification, shell } from 'electron'
import {
  CodexLocalBackend,
  resolveStableCodexHome,
  type CodexLocalBackendOptions,
} from './CodexLocalBackend'
import { migrateLegacyCodexSessions } from './codexSessionMigration'
import {
  CodexProviderStore,
  type NewCustomProvider,
  type PersistedProvidersV2,
} from './CodexProviderStore'
import { DEFAULT_CODEX_SESSION_CONFIG, type CatimationMcpLaunchInfo } from './codexLaunch'
import {
  BUILTIN_PROVIDER_PRESETS,
  DEFAULT_PROVIDER_ID,
  QWEN_UNDERSTAND_PROVIDER,
  QWEN_UNDERSTAND_PROVIDER_ID,
  APIYI_MCP_PROVIDER_ID,
  CINEMATOGRAPHY_KB_PROVIDER_ID,
  DASHVECTOR_PROVIDER_ID,
  credentialIdForProvider,
  isBuiltinProviderId,
  resolveActiveProvider,
  type ProviderPreset,
} from './codexProviders'
import { buildGatewayModelCatalog } from './gatewayModelCatalog'
import {
  channelsForGateway,
  resolveGatewayModelRoute,
  resolveProviderChannel,
} from './gatewayModelRouting'
import {
  ProviderChannelController,
  ProviderChannelRecoveryError,
} from './ProviderChannelController'
import { getDockerMcpGatewayService, type CheckInstalledResult, type GatewayStatus } from './dockerMcpGateway'
import {
  GATEWAY_DEFAULT_PORT,
  GATEWAY_PROFILE_NAME,
  GATEWAY_SERVER_NAME,
  buildGatewayConfigEntry,
  selectDockerStdioEntries,
} from './dockerMcpFix'
import {
  deleteSkill,
  getSkillDetail,
  listSkills,
  readAuditLog,
  resolveWorkspacePaths,
  saveSkill,
} from './codexConfigStore'
import { discoverCodexSkills, readMcpSummary, readRawCodexConfig } from './codexConfigDiscovery'
import { AUDIO_EXTENSIONS, mapReferencesToInputItems } from './codexUserInput'
import { validateSessionConfigPatch } from './sessionConfigValidation'
import { SessionConfigStore } from './SessionConfigStore'
import { TurnNotifier, type TurnNotification } from './TurnNotifier'
import {
  resolvePlanReasoningEffort,
  type CollaborationModeKind,
  type ConcretePlanReasoningEffort,
  type PlanReasoningEffort,
} from '../../shared/collaborationMode'
import {
  CANONICAL_MODEL_SETTINGS_ROWS,
  mergeModelSettingsCapabilities,
  modelContextPinsEqual,
  resolveModelContextPin,
} from '../../shared/modelSettings'
import type {
  CodexCollaborationMode,
  CodexCollaborationModeMask,
  CodexModelListResponse,
  CodexThreadConfigOverrides,
  CodexThreadMemoryMode,
} from './codexProtocol'
import {
  CodexRuntimeSettingsStore,
  type PersistedCodexRuntimeSettingsV1,
} from './CodexRuntimeSettingsStore'
import {
  AgentModelSelectionCoordinator,
  type AgentModelSelectionIntentReservation,
  type AgentModelSelectionRouteTarget,
} from './AgentModelSelectionCoordinator'
import type { BrowserWindow } from 'electron'
import type {
  AgentCollaborationCapabilities,
  AgentCollaborationCapabilitiesResult,
  AgentCollaborationModeUpdatePayload,
  AgentCollaborationModeUpdateResult,
  AgentModelContextApplyPayload,
  AgentModelContextApplyResult,
  AgentModelContextSnapshotResult,
  AgentModelAvailability,
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
  AgentModelSelectionIntent,
  AgentModelSelectionRecoveryResult,
  AgentModelSelectionSnapshot,
  AgentModelSettingsCatalog,
  AgentModelSettingsCatalogResult,
  AgentProviderMutationResult,
  CodexModelContextConfig,
  AgentSendMessagePayload,
  AgentSendMessageResult,
  AgentStreamEvent,
  AgentThreadBranchResult,
  AgentThreadRoutingSnapshot,
  AgentTokenUsage,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexMcpSummary,
  CodexSessionConfig,
  CodexSessionStatus,
  CodexSkillInput,
  CodexSkillsSummary,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexWorkspacePaths,
  ItemDeltaPatch,
} from '../../types/agent'
import type { AttachmentRef, DelegationSnapshot, FileChange, TimelineItem } from '../../types/agent-timeline'
import { dropSupersededStreamItems, trimRetriedStreamItems } from '../../types/agent-timeline'
import type { AttachmentService } from './AttachmentService'
import type { ThreadStore } from './ThreadStore'
import { createBackendRpcFacade } from './backendRpcFacade'
import type { AgentInput, IAgentBackend, ListThreadsParams } from './types'
import type { DoctorReport } from './codexDoctor'
import type {
  AppsListParams,
  AppsListResponse,
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigImportResponse,
  ExternalAgentConfigMigrationItem,
  MarketplaceAddParams,
  MarketplaceAddResponse,
  MarketplaceRemoveResponse,
  MarketplaceUpgradeResponse,
  PluginInstallParams,
  PluginInstallResponse,
  PluginInstalledParams,
  PluginInstalledResponse,
  PluginListParams,
  PluginListResponse,
  PluginReadParams,
  PluginReadResponse,
} from '../../types/codexPlugins'
import type { GoalRpcResult, ThreadGoal, ThreadGoalStatus } from '../../types/codexGoals'
import { ThreadTitleSummarizer } from './ThreadTitleSummarizer'
import { beginObservedChanges, type ObservedChangeTracker } from './observedChanges'
import { takeSnapshot } from './workspaceSnapshot'
import { diffSnapshots } from './snapshotDiff'
import { setFsAllowedRoots } from '../file-explorer/fsIpc'
import { setWan3TokenSource } from '../services/wan3/credentials'

const EMPTY_KEY_ERROR = '请在设置页填写 Codex Agent API Key'
/**
 * Default Codex agent model used by the ThreadTitleSummarizer (and as the
 * fallback model id when a provider preset doesn't pin its own). `gpt-5.5`
 * ships full Responses-API tool support including the native `web_search`
 * tool that Codex 0.128 `app-server` registers by default. Keep in sync with
 * the renderer-side `DEFAULT_MODEL_ID` in
 * `src/renderer/src/features/agent-chat/models.ts`.
 *
 * Provider-specific defaults (e.g. Right.Codes' `gpt-5.5` model) live in
 * `codexProviders.ts:BUILTIN_PROVIDER_PRESETS` and are wired through
 * `appendProviderArgs` — this constant is the renderer-facing fallback only.
 */
const DEFAULT_AGENT_MODEL = 'gpt-5.5'

/**
 * Subset of `AgentAttachment` (Prisma row) we need to format the prompt
 * preamble. Declared as a structural shape so tests don't have to drag in
 * the full Prisma type — the runtime data has the same field names.
 */
interface PromptAttachment {
  originalName: string
  localPath: string
  mime: string
  size: number
}

interface ResolvedCollaborationCapabilities {
  model: string
  capabilities: AgentCollaborationCapabilities
}

interface CollaborationCapabilityOwner {
  providerId: string
  backendEpoch: number | undefined
}

interface BuiltCollaborationMode {
  collaborationMode: CodexCollaborationMode
  owner?: CollaborationCapabilityOwner
}

interface DesiredProviderMutation {
  requiresApply: boolean
}

/**
 * Prepend a one-shot "[Attached files at these local paths:]" block to the
 * user's prompt when there are attachments. Without this the agent has no
 * idea where the uploaded files live (the renderer file-picker only gives
 * us a buffer; the on-disk path under `userData/agent/uploads/<sha>.<ext>`
 * is invisible to the model unless we say it explicitly).
 *
 * Behaviour:
 *  - Empty attachment list → returns `content` unchanged (no surprise
 *    bytes inflating input tokens for trivial messages).
 *  - With attachments → prepends a compact, machine-readable list with
 *    `localPath`, mime, size, and original name for each, then a blank
 *    line, then the original user content. Order matches the order the
 *    renderer sent the attachments in.
 *
 * Exported for unit tests and so a future `tools/list_attachments` MCP
 * shim can reuse the same formatting if we ever add one.
 */
export function buildPromptWithAttachments(
  content: string,
  attachments: ReadonlyArray<PromptAttachment>,
): string {
  if (attachments.length === 0) return content
  const lines = attachments.map(
    (a) => `- ${a.localPath}  (${a.mime}, ${a.size} bytes, original: ${a.originalName})`,
  )
  return `[Attached files at these local paths:\n${lines.join('\n')}]\n\n${content}`
}

function buildPromptWithReferenceMentions(content: string, mentions: readonly string[]): string {
  if (mentions.length === 0) return content
  return `[Referenced files at these local paths:\n- ${mentions.join('\n- ')}]\n\n${content}`
}

function mapDuplicateAttachmentReferencesToUploadedPaths(
  items: AgentInput['items'],
  attachmentInputs: ReadonlyArray<AgentSendMessagePayload['attachments'][number]>,
  savedAttachments: ReadonlyArray<PromptAttachment>,
): AgentInput['items'] {
  const uploadedPathByOriginalPath = new Map<string, string>()
  attachmentInputs.forEach((attachment, index) => {
    if (!attachment.path) return
    const saved = savedAttachments[index]
    if (!saved || !(saved.mime.startsWith('image/') || saved.mime.startsWith('audio/'))) return
    if (attachment.name !== saved.originalName || attachment.mime !== saved.mime) return
    uploadedPathByOriginalPath.set(path.resolve(attachment.path), saved.localPath)
  })

  if (uploadedPathByOriginalPath.size === 0) return items
  return items.map((item) => {
    if (item.type !== 'localImage' && item.type !== 'localAudio') return item
    return {
      ...item,
      path: uploadedPathByOriginalPath.get(path.resolve(item.path)) ?? item.path,
    }
  })
}

export interface AgentManagerOptions {
  /** Directory used to persist the Codex API key JSON. Inject in tests. */
  userDataDir: string
  /** Window used as the default destination for `agent:event` broadcasts. */
  win?: BrowserWindow
  /** Persistence layer for threads/messages. Required for full sendMessage flow. */
  store?: ThreadStore
  /** Attachment ingest pipeline. Required for full sendMessage flow. */
  attachments?: AttachmentService
  /**
   * Test seam for receiving `AgentStreamEvent`s instead of broadcasting to a
   * BrowserWindow. When omitted, events are sent to `win.webContents` (if
   * present and not destroyed).
   */
  eventSink?: (event: AgentStreamEvent) => void
  /**
   * Test seam for injecting a fake backend. When omitted, a real
   * `CodexLocalBackend` is constructed.
   */
  backend?: IAgentBackend
  /**
   * Narrow constructor seam for verifying default-backend callback plumbing.
   * Production omits it and constructs CodexLocalBackend directly.
   */
  backendFactory?: (options: CodexLocalBackendOptions) => IAgentBackend
  /** Runtime context-settings persistence seam. Production uses userDataDir. */
  runtimeSettingsStore?: CodexRuntimeSettingsStore
  /**
   * Local catimation MCP server coordinates produced by
   * `startCatimationMcpServer` (+ stdio bridge launch info when available).
   * Forwarded to the default `CodexLocalBackend` so the spawned Codex
   * subprocess can reach our in-app `generate_image` tool. Omitted when the
   * local MCP listener failed to bind.
   */
  mcpRuntime?: CatimationMcpLaunchInfo
}

function resolvePersistedStartupProvider(
  persisted: PersistedProvidersV2,
): {
  gatewayId: string
  channelId: string
  provider: ProviderPreset
} {
  const gateway = resolveActiveProvider(
    persisted.selectedGatewayId,
    persisted.customProviders,
  )
  if (gateway.id !== persisted.selectedGatewayId) {
    return {
      gatewayId: persisted.selectedGatewayId,
      channelId: gateway.id,
      provider: gateway,
    }
  }

  const route = resolveGatewayModelRoute(
    persisted.selectedGatewayId,
    persisted.selectedModelId,
    persisted.customProviders,
  )
  const channel = resolveProviderChannel(route.channelId, persisted.customProviders)
  return {
    gatewayId: route.gatewayId,
    channelId: route.channelId,
    provider: {
      ...channel,
      model: route.modelId,
    },
  }
}

export class AgentManager {
  private backend: IAgentBackend

  /**
   * 后端直通 RPC（配置 / 插件 / 市场 / apps / 外部 agent 配置）。这批方法不读本类
   * 的任何状态，只是把 IAgentBackend 的可选能力翻译成 {ok,error,data} 信封，实现
   * 在 backendRpcFacade.ts。下面的同名字段把公开面原样保留，调用方无需改动。
   */
  private readonly backendRpc = createBackendRpcFacade(() => this.backend)
  private win: BrowserWindow | undefined
  private readonly store: ThreadStore | undefined
  private readonly attachments: AttachmentService | undefined
  private readonly eventSink: ((event: AgentStreamEvent) => void) | undefined
  private readonly userDataDir: string
  private readonly providerStore: CodexProviderStore
  private readonly runtimeSettingsStore: CodexRuntimeSettingsStore
  private runtimeSettings: PersistedCodexRuntimeSettingsV1
  /**
   * In-flight launch pin for a context restart. `undefined` = no transition in
   * flight (spawn derives the pin from the committed selection); `null` = the
   * transition targets the unpinned/native state. Set right before the restart
   * inside applyRuntimeModelContext and cleared when the surrounding selection
   * transaction commits (persistSelection) or rolls back (restoreSelection).
   */
  private pendingContextPin: CodexModelContextConfig | null | undefined
  /** User-visible Gateway id exposed by Provider settings snapshots. */
  private activeGatewayId: string
  /** Internal Channel runtime control for backend generation switches. */
  private readonly channelController: ProviderChannelController
  /** Current catalog is the revision authority for route admission. */
  private currentModelCatalog: AgentModelSettingsCatalog
  /** Owns atomic Gateway/model/context selection and compensation. */
  private readonly modelSelectionCoordinator: AgentModelSelectionCoordinator
  private codexApiKey = ''
  /** Per-gateway model availability overrides populated by future probe flows. */
  private readonly modelAvailabilityByGateway = new Map<
    string,
    Map<string, AgentModelAvailability>
  >()
  /**
   * Miau token for the qwen understanding provider (Path B). Persisted in the
   * provider store under apiKeys['qwen'] (the renderer mirrors its image-gen
   * key there via `setProviderApiKey('qwen', …)`). Read at spawn by
   * `getUnderstandProvider`; updates take effect on the next codex (re)start.
   */
  private miauToken = ''
  /**
   * The bundled apiyi-mcp server's `APIYI_API_KEY`. Persisted in the provider
   * store under apiKeys['apiyi-mcp'] (the renderer mirrors the 设置 → API易 key
   * there via `setProviderApiKey('apiyi-mcp', …)`). Read at spawn by
   * `getApiyiKey` and injected via `-c mcp_servers.apiyi.env.APIYI_API_KEY` —
   * never written to config.toml. Changing it restarts codex so the new key
   * takes effect immediately (the user-chosen behavior).
   */
  private apiyiMcpKey = ''
  /**
   * The bundled cinematography-kb-mcp server's `DASHSCOPE_API_KEY`. Persisted in
   * the provider store under apiKeys['cinematography-kb'] (the renderer mirrors
   * the 设置 → 运镜知识库 key there via `setProviderApiKey('cinematography-kb', …)`).
   * Read at spawn by `getCinematographyKbKey` and injected via
   * `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY` — never written to
   * config.toml. Changing it restarts codex so the new key takes effect
   * immediately (same behavior as {@link apiyiMcpKey}).
   */
  private cinematographyKbKey = ''
  /**
   * Cached `collaborationMode/list` preset masks (EXPERIMENTAL RPC), fetched
   * lazily on the first Plan-mode turn and reused for the session. Upstream
   * semantics (app-server README): "Built-in presets do not select a model;
   * the Plan preset selects medium reasoning effort" — so we take
   * `reasoning_effort` from the Plan mask instead of hardcoding it, and keep
   * the user's resolved model. A failed fetch is NOT cached (retried on the
   * next Plan turn); Plan Auto safely resolves to medium when unavailable.
   */
  private collabModePresets: CodexCollaborationModeMask[] | null = null
  /**
   * Backend generation that owns the collaboration-mode caches. Undefined
   * means either no epoch-aware cache access has happened yet or the backend
   * does not expose generations (legacy backends retain their old behavior).
   */
  private collaborationCacheEpoch: number | undefined
  /**
   * Feature support belongs to the current Codex process generation. Once an
   * older binary rejects `thread/settings/update`, avoid repeating the same
   * missing RPC until a successful restart gives us a new process to probe.
   */
  private threadSettingsUpdateSupport: 'unknown' | 'supported' | 'unsupported' = 'unknown'
  /**
   * DashVector API key for the cinematography-kb-mcp server's
   * `query_sakuga_dataset` tool. Persisted under apiKeys['dashvector'] (the
   * renderer mirrors the 设置 → 运镜知识库 DashVector key there via
   * `setProviderApiKey('dashvector', …)`). Read at spawn by `getDashVectorKey`
   * and injected via `-c mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY`
   * — never written to config.toml. Change-guarded restart, same as
   * {@link cinematographyKbKey}.
   */
  private dashVectorKey = ''
  private summarizer?: ThreadTitleSummarizer
  private sessionConfig: CodexSessionConfig = { ...DEFAULT_CODEX_SESSION_CONFIG }
  private allowedRoots: string[] = [...DEFAULT_CODEX_SESSION_CONFIG.writableRoots]
  /**
   * User-confirmed session-config defaults (batch 2 persistence). Loaded once
   * in the constructor BEFORE the backend is created so the launch `-c` args
   * of the very first codex spawn already reflect the saved defaults. Written
   * only when a settings Apply carries `persist: true`.
   */
  private sessionConfigStore!: SessionConfigStore
  private sessionConfigPersisted = false
  private readonly turnNotifier: TurnNotifier
  private readonly firstTurnDoneByThread = new Map<string, boolean>()
  /**
   * Maps our DB thread row id (a Prisma CUID like `cm6abc...`) to the
   * Codex-protocol thread id (a UUID like `urn:uuid:...` returned by
   * `thread/start`). Codex's app-server validates wire ids as UUIDs, so we
   * must never leak DB cuids into `turn/start`. Mapping is in-memory only;
   * an app restart resets it (acceptable for MVP, since Codex itself doesn't
   * resume threads across app-server lifetimes).
   */
  private readonly codexThreadIdByDbThreadId = new Map<string, string>()

  /**
   * Backend generation (`backend.currentEpoch()`) under which each
   * `codexThreadId` above was minted. When codex respawns (crash self-heal or
   * provider/config restart) its epoch bumps and the old process's in-memory
   * thread is gone — so a mapping whose stored epoch != the current epoch is
   * stale and must NOT be replayed into `turn/start` (it would 404 and wedge
   * the conversation). See `resolveCodexThreadForSend`. Parallel to the id map so
   * the existing `findDbThreadId`/`cancel` value-iteration keeps working untouched.
   */
  private readonly codexThreadEpochByDbThreadId = new Map<string, number>()

  /**
   * DB thread ids for which we've already tried to hydrate a persisted codex
   * thread id from the store this process. Guards the "first send after a full
   * app restart" path in `resolveCodexThreadForSend` so we hit the DB (and
   * attempt `thread/resume`) at most once per thread per process — after that
   * the in-memory map is the source of truth, and a thread that failed to
   * resume (or never had a persisted id) starts fresh without re-querying.
   */
  private readonly codexThreadHydrationAttempted = new Set<string>()

  /**
   * Sub-agent thread ids already reported by {@link handleUnroutedEvent}. Keeps
   * the diagnostic to one line per child instead of one per streamed event.
   */
  private readonly warnedSubagentThreads = new Set<string>()

  /**
   * Sub-agent codex thread id → the DB thread of the conversation that spawned
   * it. Learned from the parent's own `collabAgentToolCall` items, which name
   * their children in `receiverThreadIds`.
   *
   * Exists because {@link resolveDbThreadId} — how the MCP `ToolRouter` decides
   * which chat a tool call belongs to — reverse-scans the DB↔codex map, and a
   * child is not in it. Without this a sub-agent's `generate_image` card lands
   * in whatever conversation happens to be open.
   */
  private readonly subagentParentByCodexThread = new Map<string, string>()

  /**
   * Live delegation items, keyed by timeline item id, with the conversation
   * they belong to and the latest snapshot we forwarded. Kept so a child's
   * token report can be merged back into the card that represents it.
   */
  private readonly delegationItems = new Map<
    string,
    { dbThreadId: string, delegation: DelegationSnapshot }
  >()

  /** Sub-agent codex thread id → the delegation item that spawned it. */
  private readonly delegationItemByChild = new Map<string, string>()

  /**
   * Latest cumulative usage reported by each sub-agent thread. Replaced, never
   * summed: `thread/tokenUsage/updated` is a per-thread snapshot.
   */
  private readonly subagentUsage = new Map<string, { input: number, output: number }>()

  /** Sub-agent codex thread id → the nickname upstream assigned that spawn. */
  private readonly subagentNickname = new Map<string, string>()

  /** Children whose thread record we have already asked for, to read it once. */
  private readonly subagentInfoRequested = new Set<string>()

  /**
   * Latest text a sub-agent emitted on its own thread. Only used when the
   * parent never reported an answer for that child — see
   * {@link recordSubagentReply}.
   */
  private readonly subagentReply = new Map<string, string>()

  /** Sub-agent threads whose own turn has ended — see {@link markSubagentFinished}. */
  private readonly subagentFinished = new Set<string>()

  /**
   * Live turn id per sub-agent thread, so a cancel can interrupt the children
   * too (see {@link interruptSubagentsOf}). Entries are removed when that
   * child's turn ends.
   */
  private readonly subagentTurnByThread = new Map<string, string>()

  /**
   * Latest status emitted per MCP server name. Populated by
   * `mcp_status_updated` notifications from codex. The renderer pulls this
   * snapshot via `getMcpStatusSnapshotRpc` on subscribe, so dots stay correct
   * even when notifications fired before the MCP page mounted (or before the
   * renderer subscribed at all).
   */
  private readonly mcpStatusByName = new Map<string, { status: string; error: string | null }>()

  /**
   * In-flight backend start, shared by the bootstrap `start()` and the lazy
   * (re)start on `sendMessage`, so a send racing the boot sequence (or retrying
   * after a swallowed boot failure) never double-spawns the codex child. The
   * promise is cleared once it settles, so a *failed* start can be retried by
   * the next send (e.g. user fixes config, sends again). See
   * `ensureBackendStarted`.
   */
  private startInFlight: Promise<void> | null = null

  /**
   * Guards the one-time {@link migrateLegacyCodexSessionsOnce} so the orphaned
   * `codex-runtime` → pinned-home rollout consolidation runs at most once per
   * app process (it's a no-op on every subsequent call anyway).
   */
  private legacySessionsMigrated = false

  /**
   * Serialization chain for codex respawns triggered by settings changes
   * (provider switch, key rotation, custom-provider edits). Respawning takes
   * seconds; queuing through one chain guarantees rapid successive changes
   * never race two spawns. Applied Provider transactions return their own
   * rejection while replacing the shared chain with a settled continuation;
   * best-effort auxiliary MCP key restarts still log and absorb failures.
   */
  private restartChain: Promise<void> = Promise.resolve()
  /** Latest Provider selection's proof that a real backend generation was applied. */
  private providerCapabilityBarrier: Promise<boolean> = Promise.resolve(true)

  constructor(opts: AgentManagerOptions) {
    this.win = opts.win
    this.store = opts.store
    this.attachments = opts.attachments
    this.eventSink = opts.eventSink
    this.userDataDir = opts.userDataDir
    // Restore user-saved session defaults before the backend snapshot below
    // captures `this.sessionConfig`. Corrupt/invalid stores resolve to `{}`
    // (factory defaults) inside the store — boot never fails on this.
    this.sessionConfigStore = new SessionConfigStore(opts.userDataDir)
    const persistedSessionOverrides = this.sessionConfigStore.loadSync()
    this.sessionConfigPersisted = Object.keys(persistedSessionOverrides).length > 0
    if (this.sessionConfigPersisted) {
      this.sessionConfig = { ...this.sessionConfig, ...persistedSessionOverrides }
    }
    // Turn-terminal OS notifications (batch 3-A): client-side toast when a
    // turn finishes/fails while the window is unfocused, mirroring the
    // official Codex desktop app (openai/codex#13019). Deps read live state
    // so panel toggles and window focus apply per event without re-wiring.
    this.turnNotifier = new TurnNotifier({
      isEnabled: () => this.sessionConfig.notifyOnTurnComplete,
      isWindowFocused: () => {
        const win = this.win
        return Boolean(win && !win.isDestroyed() && win.isFocused())
      },
      notify: (notification) => this.showSystemNotification(notification),
    })
    this.providerStore = new CodexProviderStore({ userDataDir: opts.userDataDir })
    this.runtimeSettingsStore = opts.runtimeSettingsStore
      ?? new CodexRuntimeSettingsStore(opts.userDataDir)
    this.runtimeSettings = this.runtimeSettingsStore.loadSync()
    const persisted = this.providerStore.loadSync()
    // v4.4.2 persistence migration: the store now separates the Gateway
    // choice (selectedGatewayId) from the model/channel choice
    // (selectedModelId) — see CodexProviderStore's PersistedProvidersV2.
    const restoredProvider = resolvePersistedStartupProvider(persisted)
    this.activeGatewayId = restoredProvider.gatewayId
    this.codexApiKey = persisted.apiKeys[
      credentialIdForProvider(this.activeGatewayId, persisted.customProviders)
    ] ?? ''
    this.miauToken = (persisted.apiKeys[QWEN_UNDERSTAND_PROVIDER_ID] ?? '').trim()
    // 万相 3.0 打的是同一个 Miau 网关,复用这枚 token,用户不必另配。视频服务
    // 自己去 import agent 是错的依赖方向(而另开一个 store 实例则会各缓存各的,
    // 用户改完密钥那边还是旧值),所以由这里往下推一个读实时字段的闭包 ——
    // 推一次即可,`setProviderApiKey` 刷新 `miauToken` 后自动可见。
    setWan3TokenSource(() => this.miauToken)
    this.apiyiMcpKey = (persisted.apiKeys[APIYI_MCP_PROVIDER_ID] ?? '').trim()
    this.cinematographyKbKey = (persisted.apiKeys[CINEMATOGRAPHY_KB_PROVIDER_ID] ?? '').trim()
    this.dashVectorKey = (persisted.apiKeys[DASHVECTOR_PROVIDER_ID] ?? '').trim()
    const activeProvider = restoredProvider.provider
    if (opts.backend) {
      this.backend = opts.backend
    } else {
      const createBackend = opts.backendFactory
        ?? ((options: CodexLocalBackendOptions): IAgentBackend => new CodexLocalBackend(options))
      this.backend = createBackend({
        getApiKey: () => this.codexApiKey,
        provider: activeProvider,
        sessionConfig: this.sessionConfig,
        getModelContextConfig: () => this.currentContextPin(),
        catimationMcp: opts.mcpRuntime,
        // Unlock experimental-gated RPCs (turn/start.collaborationMode for the
        // composer's Plan preset; collaborationMode/list). Smoke-verified on the
        // bundled binary: initialize + stable RPC behaviour are unaffected.
        experimentalApi: true,
        getUnderstandProvider: () =>
          this.miauToken
            ? { provider: QWEN_UNDERSTAND_PROVIDER, token: this.miauToken }
            : undefined,
        // Plan B: register EVERY Channel of the active Gateway on each spawn
        // so per-thread `modelProvider` routing can pick sibling channels
        // (e.g. rightcode-grok alongside rightcode-standard) without a codex
        // restart. Custom gateways have a single custom channel and thus no
        // siblings — channelsForGateway returns [] for them. The backend
        // filters out the active channel itself by id.
        getGatewayChannelProviders: () => channelsForGateway(this.activeGatewayId),
        getApiyiKey: () => this.apiyiMcpKey || undefined,
        getCinematographyKbKey: () => this.cinematographyKbKey || undefined,
        getDashVectorKey: () => this.dashVectorKey || undefined,
        onApprovalRequest: (request) => this.emitApprovalRequest(request),
        onApprovalResolved: (info) => this.emitApprovalResolved(info),
        onMcpNotification: (event) => this.handleMcpNotification(event),
        onUnroutedEvent: (event, context) => this.handleUnroutedEvent(event, context),
        onGoalNotification: (event) => this.handleGoalNotification(event),
        onThreadSettingsNotification: (event) => this.handleThreadSettingsNotification(event),
      })
    }
    this.channelController = new ProviderChannelController({
      backend: {
        setProvider: (provider) => this.backend.setProvider?.(provider),
        isHealthy: () => this.backend.isHealthy(),
        restartCodex: async (_paths) => {
          const restart = this.backend.restartCodex?.bind(this.backend)
          if (!restart) {
            throw new Error(
              'Active backend cannot apply Channel changes without restart support',
            )
          }
          const previousEpoch = this.backend.currentEpoch?.()
          await this.restartBackendWithGenerationCheck(restart)
          const nextEpoch = this.backend.currentEpoch?.()
          if (!this.backend.isHealthy()) {
            throw new Error('Provider restart completed without a healthy backend')
          }
          if (
            previousEpoch !== undefined
            && (nextEpoch === undefined || nextEpoch === previousEpoch)
          ) {
            throw new Error('Provider restart did not create a new backend generation')
          }
        },
        ...(this.backend.currentEpoch
          ? { currentEpoch: () => this.backend.currentEpoch!() }
          : {}),
      },
      paths: this.workspacePaths(),
      initialChannelId: restoredProvider.channelId,
      getCustomProviders: () => this.providerStore.loadSync().customProviders,
    })
    try {
      this.currentModelCatalog = this.fallbackModelSettingsCatalog(
        this.activeGatewayId,
        persisted.customProviders,
      )
    } catch {
      // A malformed persisted Gateway still starts through the legacy default
      // Channel fallback. Keep its catalog equally recoverable so construction
      // never fails before the user can repair the Provider selection.
      this.currentModelCatalog = this.fallbackModelSettingsCatalog(
        DEFAULT_PROVIDER_ID,
        persisted.customProviders,
      )
    }
    this.modelSelectionCoordinator = new AgentModelSelectionCoordinator({
      channelController: this.channelController,
      getSnapshot: (threadId) => this.modelSelectionSnapshot(threadId),
      catalogRevisionIsCurrent: (gatewayId, revision) =>
        this.currentModelCatalog.gatewayId === gatewayId
        && this.currentModelCatalog.revision === revision,
      applyContext: (contextWindow, requestVersion, pin) =>
        this.applyRuntimeModelContext(contextWindow, requestVersion, pin),
      resolveContextPin: (modelId, contextWindow) =>
        resolveModelContextPin(modelId, contextWindow),
      persistSelection: (snapshot, threadId) =>
        this.persistModelSelection(snapshot, threadId),
      restoreSelection: (snapshot, threadId) =>
        this.restoreModelSelection(snapshot, threadId),
      resumeThread: (threadId, target) =>
        this.resumeSelectedThread(threadId, target),
      backendEpoch: () => this.backend.currentEpoch?.(),
      hasInFlightWork: () => this.backend.hasInFlightWork?.()
        ?? this.backend.hasActiveTurns?.()
        ?? false,
      // Plan B: a switch is servable WITHOUT a restart only when the LIVE
      // spawn actually registered the target Channel's provider table (the
      // spawn registers every sibling of its gateway, see
      // getGatewayChannelProviders). Cross-gateway targets, custom gateways
      // (no siblings), unhealthy/un-spawned backends, and backends without
      // the registration probe all keep the original restart transaction.
      canRouteInProcess: (previous, route) =>
        route.gatewayId === this.activeGatewayId
        && previous.gatewayId === this.activeGatewayId
        && this.backend.isHealthy()
        && (this.backend.hasRegisteredProviderChannel?.(route.channelId) ?? false),
      threadHasInFlightWork: (threadId) => {
        const codexThreadId = this.codexThreadIdByDbThreadId.get(threadId)
        if (!codexThreadId) return false
        return this.backend.hasInFlightWorkForThread?.(codexThreadId)
          ?? this.backend.hasInFlightWork?.()
          ?? false
      },
      prepareRecovery: (snapshot) => {
        this.pendingContextPin = resolveModelContextPin(
          snapshot.modelId,
          snapshot.contextWindow,
        )
        this.runtimeSettings = {
          version: 1,
          confirmed: { ...this.runtimeSettings.confirmed },
          pending: {
            target: {
              modelContextWindow: snapshot.contextWindow,
              modelAutoCompactTokenLimit: snapshot.autoCompactTokenLimit,
            },
            requestVersion: 0,
            startedAt: new Date().toISOString(),
          },
        }
      },
      validateRecovery: (snapshot, threadId) =>
        this.validateModelSelectionRecovery(snapshot, threadId),
      refreshRecoveryCatalog: (snapshot) =>
        this.refreshModelSelectionRecoveryCatalog(snapshot),
      resolveContext: (payload, previous) =>
        this.resolveModelSelectionContext(payload, previous),
      resolveRoute: (gatewayId, modelId) => {
        const persistedProviders = this.providerStore.loadSync()
        return resolveGatewayModelRoute(
          gatewayId,
          modelId,
          persistedProviders.customProviders,
        )
      },
      validateIntent: (payload, route) =>
        this.validateModelSelectionIntent(payload, route.modelId, route.channelId),
    })
    if (this.store) {
      this.summarizer = new ThreadTitleSummarizer(this.store, this.backend, DEFAULT_AGENT_MODEL)
    }
    // Kick off async legacy migration in the background — the sync load above
    // already covered the v4.3 file; this finishes the codex-agent.json →
    // codex-providers.json one-way migration the first time the manager
    // boots after upgrade. Failures are best-effort: the worst case is the
    // user re-types their key once.
    void this.providerStore.load().catch(() => {})
  }

  /**
   * Test seam: when callers inject a custom backend via `opts.backend` they
   * miss the `onMcpNotification` plumbing the default factory wires. Calling
   * this method lets a test re-attach the same handler to the injected
   * backend's `onMcpNotification` registration hook.
   */
  attachMcpNotificationHandler(): void {
    const b = this.backend as { onMcpNotification?: (handler: (e: AgentStreamEvent) => void) => void }
    if (typeof b.onMcpNotification === 'function') {
      b.onMcpNotification((event) => this.handleMcpNotification(event))
    }
  }

  /**
   * Native `/goal` updates (`thread/goal/updated|cleared`) arrive keyed by the
   * CODEX thread id; the renderer store is keyed by our DB thread id, so we
   * reverse-map before forwarding. Unknown mappings are dropped (a goal on a
   * thread the renderer doesn't track can't be attributed).
   */
  private handleGoalNotification(event: AgentStreamEvent): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const e = event as { type?: string; threadId?: string }
    if (typeof e.threadId !== 'string') return
    const dbThreadId = this.resolveDbThreadId(e.threadId) ?? e.threadId
    win.webContents.send('agent:goal', { ...event, threadId: dbThreadId })
  }

  /**
   * Persistent thread-setting confirmations are keyed by Codex UUIDs. Resolve
   * through the existing DB→Codex map and drop unknown/background-orphaned
   * notifications so a protocol id can never leak into renderer state.
   */
  private handleThreadSettingsNotification(
    event: Extract<AgentStreamEvent, { type: 'thread_settings_updated' }>,
  ): void {
    const dbThreadId = this.resolveDbThreadId(event.threadId)
    if (!dbThreadId) return
    this.emitEvent({ ...event, threadId: dbThreadId })
  }

  private handleMcpNotification(event: AgentStreamEvent): void {
    if (event && (event as any).type === 'mcp_status_updated') {
      const e = event as any
      if (typeof e.name === 'string') {
        this.mcpStatusByName.set(e.name, {
          status: String(e.status ?? 'unknown'),
          error: e.error ?? null,
        })
      }
    }
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('agent:mcp-status', event)
  }

  getMcpStatusSnapshotRpc(): {
    ok: true
    snapshot: Record<string, { status: string; error: string | null }>
  } {
    const snapshot: Record<string, { status: string; error: string | null }> = {}
    for (const [name, value] of this.mcpStatusByName) {
      snapshot[name] = { status: value.status, error: value.error }
    }
    return { ok: true, snapshot }
  }

  private workspacePaths(): CodexWorkspacePaths {
    const home = os.homedir()
    return resolveWorkspacePaths({
      home,
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      userData: this.userDataDir,
      // `app` may be `undefined` in vitest contexts that don't mock electron;
      // we treat that case as "not packaged" so system-scope skill discovery
      // simply skips, matching the dev-mode runtime behaviour.
      resourcesPath: app?.isPackaged ? process.resourcesPath : undefined,
      // Surface legacy USER-scope skill locations so `listSkills` finds:
      //   - skills written by this app's legacy `save-skill` IPC and
      //     "打开 Skills 文件夹" button (<userData>/skills) — this is where
      //     AI-created skills currently land.
      //   - the Codex CLI legacy USER path (~/.codex/skills), still loaded
      //     by the official CLI per openai/codex#14337.
      legacyUserSkillsRoots: [
        path.join(this.userDataDir, 'skills'),
        path.join(home, '.codex', 'skills'),
      ],
    })
  }

  private async applyMcpConfigChange(paths: CodexWorkspacePaths): Promise<void> {
    if (!this.backend.applyConfigChange) {
      throw new Error('Codex config refresh API is unavailable')
    }
    await this.backend.applyConfigChange(paths)
  }

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  getCodexApiKey(): string {
    return this.codexApiKey
  }

  /**
   * Sets the API key for the *currently active* provider. Preserved as the
   * IPC `agent:set-api-key` entry-point to keep the v4.2 settings UI
   * working — new code paths should prefer `setProviderApiKey(id, key)`.
   */
  async setCodexApiKey(key: string): Promise<void> {
    await this.setProviderApiKey(this.activeGatewayId, key)
  }

  // ---------------------------------------------------------------------
  // Codex provider management (v4.3+)
  // ---------------------------------------------------------------------

  /**
   * Returns the snapshot used by the Settings page: builtin presets, custom
   * providers, the active id, and the per-provider api keys (so the UI can
   * prefill input fields without a second roundtrip). Keys are returned
   * verbatim — callers that render them in the DOM should mask them via
   * the existing `<ApiKeyInput showToggle>` component.
   */
  async getProvidersSnapshot(): Promise<{
    builtins: ProviderPreset[]
    custom: ProviderPreset[]
    activeId: string
    apiKeys: Record<string, string>
  }> {
    const persisted = await this.providerStore.load()
    return {
      builtins: BUILTIN_PROVIDER_PRESETS.map((p) => ({ ...p })),
      custom: persisted.customProviders.map((p) => ({ ...p })),
      // UI state exposes the user-facing Gateway only. The backend's internal
      // Channel identity is owned by ProviderChannelController.
      activeId: this.activeGatewayId,
      apiKeys: { ...persisted.apiKeys },
    }
  }

  /**
   * Gateway-facing snapshot for the renderer. Thin alias over
   * {@link getProvidersSnapshot}: builtin presets already are the user-facing
   * Gateway cards (internal Channels stay hidden), so no second source of
   * truth is introduced.
   */
  getGatewaysSnapshotRpc(): Promise<{
    builtins: ProviderPreset[]
    custom: ProviderPreset[]
    activeId: string
    apiKeys: Record<string, string>
  }> {
    return this.getProvidersSnapshot()
  }

  /**
   * Activates a user-facing Gateway. Thin alias over {@link setActiveProvider}
   * so Gateway IPC reuses the single applied-provider transaction.
   */
  setActiveGatewayRpc(
    id: string,
  ): Promise<{ ok: true } & AgentProviderMutationResult> {
    return this.setActiveProvider(id)
  }

  /**
   * Updates a Gateway credential. Thin alias over {@link setProviderApiKey};
   * per-gateway keys share the existing credential store and transaction.
   */
  setGatewayApiKeyRpc(
    id: string,
    key: string,
  ): Promise<{ ok: true } & AgentProviderMutationResult> {
    return this.setProviderApiKey(id, key)
  }

  async setActiveProvider(
    id: string,
  ): Promise<{ ok: true } & AgentProviderMutationResult> {
    return this.enqueueAppliedProviderTransaction(async (before) => {
      const provider = resolveActiveProvider(id, before.customProviders)
      if (provider.id !== id) {
        throw new Error(`Unknown Codex provider id "${id}"`)
      }
      await this.providerStore.setSelectedId(id)
      return {
        requiresApply: false,
      }
    })
  }

  /**
   * Enqueue a codex respawn on {@link restartChain}. Returns the promise for
   * callers that must await completion; UI-latency-sensitive callers drop it
   * (`void`) so the IPC reply is instant. No-op resolve when the backend has
   * no restart hook (stub backends in tests).
   */
  private queueBackendRestart(reason: string): Promise<void> {
    const restart = this.backend.restartCodex?.bind(this.backend)
    if (!restart) return Promise.resolve()
    const next = this.restartChain.then(async () => {
      try {
        await this.restartBackendWithGenerationCheck(restart)
      } catch (err) {
        console.warn(`[AgentManager] restartCodex (${reason}) failed:`, err)
      }
    })
    this.restartChain = next
    return next
  }

  private enqueueProviderStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueLifecycleOperation(operation)
  }

  /** Blocks Provider mutations until an unprovable model runtime is recovered. */
  private assertModelSelectionRecoveryResolved(): void {
    const recovery = this.modelSelectionCoordinator.getRecoveryState()
    if (!recovery.recoveryRequired) return
    throw new Error(
      `Model-selection recovery required before Provider mutation: ${recovery.error ?? 'runtime identity is unprovable'}`,
    )
  }

  private enqueueLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.restartChain.then(operation)
    this.restartChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Serialize a new turn's admission with Provider replacement. The lifecycle
   * tail is released as soon as backend.send has registered its first
   * iterator.next() (CodexProtocolClient increments activeSends synchronously),
   * not when the whole turn completes. A following Provider apply therefore
   * observes the in-flight turn and rejects quickly instead of replacing its
   * client, while sends queued behind a replacement cannot enter the old one.
   */
  private enqueueTurnAdmission<T>(admit: () => Promise<T>): Promise<T> {
    return this.enqueueLifecycleOperation(admit)
  }

  private enqueueAppliedProviderTransaction(
    mutateDesired: (
      before: PersistedProvidersV2,
    ) => Promise<DesiredProviderMutation>,
  ): Promise<{ ok: true } & AgentProviderMutationResult> {
    let capabilityReady = false
    const transaction = this.restartChain.then(async () => {
      this.assertModelSelectionRecoveryResolved()
      const before = await this.providerStore.load()
      const previousActiveGatewayId = this.activeGatewayId
      const previousAppliedChannelId = this.channelController.currentChannelId()
      const previousKey = this.codexApiKey
      const previousEpoch = this.backend.currentEpoch?.()
      const previousHealthy = this.backend.isHealthy()
      const previousProvider = resolvePersistedStartupProvider(before).provider
      let desiredPersisted = false
      let channelApplyAttempted = false

      try {
        const desired = await mutateDesired(before)
        desiredPersisted = true
        const persisted = await this.providerStore.load()
        const restoredProvider = resolvePersistedStartupProvider(persisted)
        const provider = restoredProvider.provider
        const nextKey = persisted.apiKeys[
          credentialIdForProvider(restoredProvider.gatewayId, persisted.customProviders)
        ] ?? ''
        let providerGeneration = this.backend.currentEpoch?.()
        const requiresApply =
          desired.requiresApply
          || restoredProvider.channelId !== this.channelController.currentChannelId()

        if (requiresApply) {
          this.codexApiKey = nextKey
          if (
            restoredProvider.channelId
            !== this.channelController.currentChannelId()
          ) {
            channelApplyAttempted = true
            providerGeneration = await this.applyChannelGeneration(
              restoredProvider.channelId,
              previousProvider,
            )
          } else {
            providerGeneration = await this.applyProviderGeneration(provider)
          }
        }

        this.activeGatewayId = restoredProvider.gatewayId
        this.codexApiKey = nextKey
        this.currentModelCatalog = this.fallbackModelSettingsCatalog(
          restoredProvider.gatewayId,
          persisted.customProviders,
        )
        capabilityReady = true
        return {
          ok: true as const,
          activeId: restoredProvider.gatewayId,
          ...(providerGeneration !== undefined ? { providerGeneration } : {}),
        }
      } catch (error) {
        const recoveryFailures: string[] = []
        const channelRollbackRecovered =
          channelApplyAttempted
          && this.channelController.currentChannelId() === previousAppliedChannelId
          && this.backend.isHealthy()
          && !(error instanceof ProviderChannelRecoveryError)
        try {
          if (desiredPersisted) {
            try {
              await this.providerStore.restore(before)
            } catch (restoreError) {
              recoveryFailures.push(`store: ${errorMessage(restoreError)}`)
            }
          }
        } finally {
          this.activeGatewayId = previousActiveGatewayId
          this.codexApiKey = previousKey
          if (this.channelController.currentChannelId() !== previousAppliedChannelId) {
            try {
              await this.channelController.restore(
                previousAppliedChannelId,
                previousProvider,
              )
            } catch (restoreError) {
              recoveryFailures.push(
                `channel: ${errorMessage(restoreError)}`,
              )
              this.backend.setProvider?.(previousProvider)
            }
          } else if (!channelRollbackRecovered && !channelApplyAttempted) {
            this.backend.setProvider?.(previousProvider)
          }
        }

        if (previousHealthy && !channelRollbackRecovered && !channelApplyAttempted) {
          const oldGenerationStillHealthy =
            previousEpoch !== undefined
            && this.backend.currentEpoch?.() === previousEpoch
            && this.backend.isHealthy()
          if (!oldGenerationStillHealthy) {
            const restart = this.backend.restartCodex?.bind(this.backend)
            if (!restart) {
              recoveryFailures.push('restart: Codex restart API is unavailable')
            } else {
              const recoveryEpoch = this.backend.currentEpoch?.()
              try {
                await this.restartBackendWithGenerationCheck(restart)
                const restoredEpoch = this.backend.currentEpoch?.()
                if (!this.backend.isHealthy()) {
                  throw new Error('old Provider recovery completed without a healthy backend')
                }
                if (
                  recoveryEpoch === undefined
                  || restoredEpoch === undefined
                  || restoredEpoch === recoveryEpoch
                ) {
                  throw new Error('old Provider recovery did not create a new backend generation')
                }
              } catch (recoveryError) {
                recoveryFailures.push(`restart: ${errorMessage(recoveryError)}`)
              }
            }
          }
        }
        capabilityReady =
          (!channelApplyAttempted || channelRollbackRecovered)
          && recoveryFailures.length === 0
        if (recoveryFailures.length > 0) {
          throw new Error(
            `${errorMessage(error)}; Provider recovery failed: ${recoveryFailures.join('; ')}`,
            { cause: error },
          )
        }
        throw error
      }
    })

    // The chain remains usable after a failed transaction, but each caller
    // still receives its own rejection. Capabilities wait for the latest
    // transaction (including rollback) before binding a Provider owner.
    this.restartChain = transaction.then(
      () => undefined,
      () => undefined,
    )
    this.providerCapabilityBarrier = transaction.then(
      () => true,
      () => capabilityReady,
    )
    return transaction
  }

  private async applyChannelGeneration(
    channelId: string,
    rollbackProvider: ProviderPreset,
  ): Promise<number | undefined> {
    const transition = await this.channelController.apply(
      channelId,
      rollbackProvider,
    )
    return transition.backendEpoch
  }

  private async applyProviderGeneration(
    provider: ProviderPreset,
  ): Promise<number | undefined> {
    const previousEpoch = this.backend.currentEpoch?.()
    this.backend.setProvider?.(provider)

    // No live generation exists, so setting the pending backend config is the
    // complete apply operation. The next lazy start owns this Provider.
    if (!this.backend.isHealthy()) return previousEpoch

    const restart = this.backend.restartCodex?.bind(this.backend)
    if (!restart) {
      // Alternate/test backends without Provider plumbing retain their legacy
      // immediate semantics. A backend exposing setProvider must also expose a
      // restart hook so a healthy generation can be proven.
      if (!this.backend.setProvider) return previousEpoch
      throw new Error('Active backend cannot apply Provider changes without restart support')
    }

    await this.restartBackendWithGenerationCheck(restart)
    const nextEpoch = this.backend.currentEpoch?.()
    if (!this.backend.isHealthy()) {
      throw new Error('Provider restart completed without a healthy backend')
    }
    if (
      previousEpoch !== undefined
      && (nextEpoch === undefined || nextEpoch === previousEpoch)
    ) {
      throw new Error('Provider restart did not create a new backend generation')
    }
    return nextEpoch
  }

  private async restartBackendWithGenerationCheck(
    restart: (paths: CodexWorkspacePaths) => Promise<void>,
  ): Promise<void> {
    this.syncCollaborationProcessCaches()
    await restart(this.workspacePaths())
    this.syncCollaborationProcessCaches()
  }

  private syncCollaborationProcessCaches(): void {
    const currentEpoch = this.backend.currentEpoch?.()
    if (currentEpoch === undefined) return
    if (this.collaborationCacheEpoch === undefined) {
      this.collaborationCacheEpoch = currentEpoch
      return
    }
    if (this.collaborationCacheEpoch === currentEpoch) return

    this.collabModePresets = null
    this.threadSettingsUpdateSupport = 'unknown'
    this.collaborationCacheEpoch = currentEpoch
  }

  async setProviderApiKey(
    id: string,
    key: string,
  ): Promise<{ ok: true } & AgentProviderMutationResult> {
    this.assertModelSelectionRecoveryResolved()
    const next = (key ?? '').trim()
    const isAuxiliaryProviderKey =
      id === QWEN_UNDERSTAND_PROVIDER_ID
      || id === APIYI_MCP_PROVIDER_ID
      || id === CINEMATOGRAPHY_KB_PROVIDER_ID
      || id === DASHVECTOR_PROVIDER_ID

    if (!isAuxiliaryProviderKey) {
      return this.enqueueAppliedProviderTransaction(async (before) => {
        const credentialId = credentialIdForProvider(id, before.customProviders)
        const activeCredentialId = credentialIdForProvider(
          this.activeGatewayId,
          before.customProviders,
        )
        const previous = before.apiKeys[credentialId] ?? ''
        await this.providerStore.setApiKey(id, next)
        return {
          requiresApply: credentialId === activeCredentialId && next !== previous,
        }
      })
    }

    // Auxiliary MCP/understanding keys are intentionally not Codex Provider
    // selection transactions. Preserve their dedicated restart behavior.
    await this.enqueueProviderStoreOperation(() => {
      // Root gate re-checked at execution time: a queued selection ahead of
      // this write may poison the runtime after the entry-time check passed.
      this.assertModelSelectionRecoveryResolved()
      return this.providerStore.setApiKey(id, next)
    })
    // The renderer mirrors its image-gen Miau token here (id='qwen') so Path B
    // subagents can reach the qwen understanding gateway. Keep the in-memory
    // copy fresh; it is consumed at the next codex (re)start via
    // getUnderstandProvider.
    if (id === QWEN_UNDERSTAND_PROVIDER_ID) {
      this.miauToken = next
    }
    // The renderer mirrors the 设置 → API易 key here (id='apiyi-mcp') so the
    // bundled apiyi-mcp server gets its `APIYI_API_KEY` injected at spawn via
    // `-c` (never written to config.toml). Restart codex ON CHANGE so the new
    // key takes effect immediately — the behavior the user picked. The
    // change-guard is essential: the renderer re-pushes this key idempotently
    // on every app boot / MCP-page load (constructor + saveApiKey + useMcpStore
    // cold-start hook), and restarting on each of those would be a restart
    // storm. On boot the in-memory copy is preloaded from the provider store,
    // so the first idempotent push is a no-op.
    if (id === APIYI_MCP_PROVIDER_ID) {
      const changed = next !== this.apiyiMcpKey
      this.apiyiMcpKey = next
      if (changed && next) {
        await this.queueBackendRestart('apiyi-mcp key change')
      }
    }
    // The renderer mirrors the 设置 → 运镜知识库 key here (id='cinematography-kb')
    // so the bundled cinematography-kb-mcp server gets its `DASHSCOPE_API_KEY`
    // injected at spawn via `-c` (never written to config.toml). Same
    // change-guarded restart as apiyi-mcp above (the renderer re-pushes this key
    // idempotently on boot / save, so restarting only on a real change avoids a
    // restart storm; the constructor preloads the in-memory copy so the first
    // idempotent re-push is a no-op).
    if (id === CINEMATOGRAPHY_KB_PROVIDER_ID) {
      const changed = next !== this.cinematographyKbKey
      this.cinematographyKbKey = next
      if (changed && next) {
        await this.queueBackendRestart('cinematography-kb key change')
      }
    }
    // The renderer mirrors the 设置 → 运镜知识库 DashVector key here
    // (id='dashvector') for query_sakuga_dataset. Same change-guarded restart
    // rationale as the two blocks above.
    if (id === DASHVECTOR_PROVIDER_ID) {
      const changed = next !== this.dashVectorKey
      this.dashVectorKey = next
      if (changed && next) {
        await this.queueBackendRestart('dashvector key change')
      }
    }
    const providerGeneration = this.backend.currentEpoch?.()
    return {
      ok: true,
      activeId: this.activeGatewayId,
      ...(providerGeneration !== undefined ? { providerGeneration } : {}),
    }
  }

  async addCustomProvider(input: NewCustomProvider): Promise<ProviderPreset> {
    this.assertModelSelectionRecoveryResolved()
    const trimmedName = input.name?.trim() ?? ''
    if (!trimmedName) throw new Error('Provider name is required')
    try {
      new URL(input.baseUrl)
    } catch {
      throw new Error('Provider baseUrl must be a valid URL')
    }
    return this.enqueueProviderStoreOperation(
      () => {
        this.assertModelSelectionRecoveryResolved()
        return this.providerStore.addCustomProvider({ ...input, name: trimmedName })
      },
    )
  }

  async updateCustomProvider(
    id: string,
    patch: Partial<Omit<ProviderPreset, 'id' | 'isCustom'>>,
  ): Promise<{ ok: true } & AgentProviderMutationResult> {
    this.assertModelSelectionRecoveryResolved()
    if (isBuiltinProviderId(id)) throw new Error('Cannot update builtin provider')
    if (patch.baseUrl !== undefined) {
      try {
        new URL(patch.baseUrl)
      } catch {
        throw new Error('Provider baseUrl must be a valid URL')
      }
    }
    return this.enqueueAppliedProviderTransaction(async () => {
      await this.providerStore.updateCustomProvider(id, patch)
      return {
        requiresApply: id === this.activeGatewayId,
      }
    })
  }

  async removeCustomProvider(
    id: string,
  ): Promise<{ ok: true } & AgentProviderMutationResult> {
    this.assertModelSelectionRecoveryResolved()
    if (isBuiltinProviderId(id)) throw new Error('Cannot remove builtin provider')
    return this.enqueueAppliedProviderTransaction(async () => {
      const wasActive = this.activeGatewayId === id
      await this.providerStore.removeCustomProvider(id)
      return {
        requiresApply: wasActive,
      }
    })
  }

  async setAllowedRoots(roots: unknown): Promise<string[]> {
    if (!Array.isArray(roots)) return [...this.sessionConfig.writableRoots]

    const validated: string[] = []
    for (const candidate of roots) {
      if (typeof candidate !== 'string') continue
      const resolved = path.resolve(candidate)
      if (!path.isAbsolute(resolved)) continue
      try {
        const stat = await fs.stat(resolved)
        if (stat.isDirectory()) validated.push(resolved)
      } catch {
        // Ignore stale workspace roots.
      }
    }

    this.allowedRoots = [...validated]
    this.sessionConfig = { ...this.sessionConfig, writableRoots: [...validated] }
    this.backend.setSessionConfig?.({ writableRoots: [...validated] })
    setFsAllowedRoots(validated)
    return [...validated]
  }

  async setSessionConfigPatch(
    input: unknown,
    options?: { persist?: boolean },
  ): Promise<CodexSessionStatus> {
    const patch = validateSessionConfigPatch(input, this.allowedRoots)
    await this.confirmUnsafeSessionConfigChange(patch)
    this.sessionConfig = {
      ...this.sessionConfig,
      ...patch,
      writableRoots: patch.writableRoots ? [...patch.writableRoots] : [...this.sessionConfig.writableRoots],
    }
    this.backend.setSessionConfig?.(patch)
    // "保存为默认": snapshot the FULL post-patch config (not just this patch)
    // so earlier in-memory-only tweaks are captured too. `persist` must be an
    // explicit boolean true — the flag rides IPC, so no truthy coercion.
    if (options && typeof options === 'object' && options.persist === true) {
      this.sessionConfigStore.saveSync(this.sessionConfig)
      this.sessionConfigPersisted = this.sessionConfigStore.hasPersistedOverrides()
    }
    return this.getSessionStatus()
  }

  /**
   * "恢复出厂默认": drop the persisted snapshot and restore the shipped
   * defaults in memory + backend. Exempt from the unsafe-edge confirmation
   * dialog (same exemption as boot — it restores the values a pristine
   * install already runs with; the renderer gates it behind a two-step
   * confirm). Workspace-derived `writableRoots` are preserved.
   */
  async resetSessionConfigToFactory(): Promise<CodexSessionStatus> {
    this.sessionConfigStore.clearSync()
    this.sessionConfigPersisted = false
    this.sessionConfig = {
      ...DEFAULT_CODEX_SESSION_CONFIG,
      writableRoots: [...this.sessionConfig.writableRoots],
    }
    const patch: Partial<CodexSessionConfig> = { ...DEFAULT_CODEX_SESSION_CONFIG }
    delete patch.writableRoots
    this.backend.setSessionConfig?.(patch)
    return this.getSessionStatus()
  }

  getSessionStatus(model: string = DEFAULT_AGENT_MODEL): CodexSessionStatus {
    return {
      model,
      sandboxMode: this.sessionConfig.sandboxMode,
      approvalPolicy: this.sessionConfig.approvalPolicy,
      webSearch: this.sessionConfig.webSearch,
      personality: this.sessionConfig.personality,
      reasoningSummary: this.sessionConfig.reasoningSummary,
      showRawReasoning: this.sessionConfig.showRawReasoning,
      modelVerbosity: this.sessionConfig.modelVerbosity,
      notifyOnTurnComplete: this.sessionConfig.notifyOnTurnComplete,
      memoriesEnabled: this.sessionConfig.memoriesEnabled,
      persistedDefaults: this.sessionConfigPersisted,
      writableRoots: [...this.sessionConfig.writableRoots],
    }
  }

  async getMcpSummary(): Promise<CodexMcpSummary> {
    return readMcpSummary(path.join(os.homedir(), '.codex', 'config.toml'))
  }

  async getSkillsSummary(): Promise<CodexSkillsSummary> {
    const home = os.homedir()
    return discoverCodexSkills({
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      home,
      // Same defensive guard as `workspacePaths()` — see note there.
      resourcesPath: app?.isPackaged ? process.resourcesPath : undefined,
      // Mirror `workspacePaths().legacyUserSkillsRoots` so the `/` palette
      // and `$skill` popup see the same USER-scope inventory the
      // SkillsSection panel does. Without this, AI-created skills under
      // `<userData>/skills` (e.g. catimation-cyberpunk-master) and Codex
      // CLI legacy `$HOME/.codex/skills` entries surface in the side panel
      // but stay invisible in the chat command palette.
      legacyUserSkillsRoots: [
        path.join(this.userDataDir, 'skills'),
        path.join(home, '.codex', 'skills'),
      ],
    })
  }

  async listSkills() {
    return listSkills(this.workspacePaths())
  }

  async getSkillDetail(id: string) {
    return getSkillDetail(this.workspacePaths(), id)
  }

  async saveSkill(input: CodexSkillInput) {
    return saveSkill(this.workspacePaths(), input)
  }

  async deleteSkill(id: string) {
    return deleteSkill(this.workspacePaths(), id)
  }

  /**
   * Reveals a scope-specific skills root in the OS file browser. Unlike the
   * legacy `open-skills-folder` IPC (which always opens `<userData>/skills`),
   * this routes by scope so the side panel can give each group header its
   * own "open" button:
   *   - `repo`   → workspace `.agents/skills`
   *   - `user`   → `$HOME/.agents/skills` (the official Codex USER path)
   *   - `system` → packaged installer skills (read-only)
   *
   * Ensures the directory exists before opening so first-time users don't
   * hit a "folder not found" toast on a fresh checkout.
   */
  async openSkillsRoot(
    scope: 'repo' | 'user' | 'system',
  ): Promise<{ ok: true; path: string } | { ok: false; error: string; path?: string }> {
    const paths = this.workspacePaths()
    let target: string | undefined
    switch (scope) {
      case 'repo':
        target = paths.workspaceSkillsRoot
        break
      case 'user':
        target = paths.personalSkillsRoot
        break
      case 'system':
        target = paths.systemSkillsRoot
        break
      default: {
        const _exhaustive: never = scope
        return { ok: false, error: `Unknown scope: ${String(_exhaustive)}` }
      }
    }
    if (!target) return { ok: false, error: `No path resolved for scope ${scope}` }

    try {
      // Read-only SYSTEM skills are bundled with the installer; skipping
      // `mkdir` avoids EPERM noise on packaged builds.
      if (scope !== 'system') {
        await fs.mkdir(target, { recursive: true })
      }
      const errorMessage = await shell.openPath(target)
      if (errorMessage) return { ok: false, error: errorMessage, path: target }
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), path: target }
    }
  }

  async getWorkspaceLogs(opts?: { limit?: number; sinceIso?: string }) {
    return readAuditLog(this.workspacePaths().auditLogPath, opts ?? {})
  }

  async restartCodex() {
    if (!this.backend.restartCodex) throw new Error('Codex restart API is unavailable')
    const restart = this.backend.restartCodex.bind(this.backend)
    await this.enqueueLifecycleOperation(
      () => this.restartBackendWithGenerationCheck(restart),
    )
  }

  async getModelSettingsCatalogRpc(): Promise<AgentModelSettingsCatalogResult> {
    const maxOwnerAttempts = 3
    for (let attempt = 1; attempt <= maxOwnerAttempts; attempt += 1) {
      const providerBarrier = this.providerCapabilityBarrier
      const providerReady = await providerBarrier
      if (providerBarrier !== this.providerCapabilityBarrier) continue

      const provider = this.channelController.currentChannelId()
      const gatewayId = this.activeGatewayId
      const customProviders = this.providerStore.loadSync().customProviders
      const backendEpoch = this.backend.currentEpoch?.()
      const ownerStillCurrent = (): boolean =>
        this.providerCapabilityBarrier === providerBarrier
        && this.channelController.currentChannelId() === provider
        && (
          backendEpoch === undefined
          || this.backend.currentEpoch?.() === backendEpoch
        )

      if (!providerReady || typeof this.backend.listModels !== 'function') {
        return {
          ok: true,
          data: this.publishModelSettingsCatalog(
            this.fallbackModelSettingsCatalog(gatewayId, customProviders),
          ),
        }
      }

      let response: CodexModelListResponse
      try {
        response = await this.backend.listModels({ includeHidden: false })
      } catch {
        if (!ownerStillCurrent()) continue
        return {
          ok: true,
          data: this.publishModelSettingsCatalog(
            this.fallbackModelSettingsCatalog(gatewayId, customProviders),
          ),
        }
      }
      if (!ownerStillCurrent()) continue

      const catalog = buildGatewayModelCatalog({
        gatewayId,
        dynamicSource: 'codex',
        dynamicModels: response.data.map((row) => ({
          id: row.id,
          displayName: row.displayName,
          description: row.description,
          hidden: row.hidden,
          isDefault: row.isDefault,
          defaultReasoningEffort: row.defaultReasoningEffort,
          supportedReasoningEfforts: row.supportedReasoningEfforts.map(
            (effort) => effort.reasoningEffort,
          ),
        })),
        customProviders,
        hasCredential: (credentialId) => this.hasCredentialFor(credentialId),
        availabilityByModel: this.modelAvailabilityByGateway.get(gatewayId)
          ?? new Map(),
      })
      return { ok: true, data: this.publishModelSettingsCatalog(catalog) }
    }
    const gatewayId = this.activeGatewayId
    const customProviders = this.providerStore.loadSync().customProviders
    console.warn(
      `[AgentManager] model settings catalog owner changed ${maxOwnerAttempts} times; using fallback for ${gatewayId}`,
    )
    return {
      ok: true,
      data: this.publishModelSettingsCatalog(
        this.fallbackModelSettingsCatalog(gatewayId, customProviders),
      ),
    }
  }

  private publishModelSettingsCatalog(
    catalog: AgentModelSettingsCatalog,
  ): AgentModelSettingsCatalog {
    if (catalog.gatewayId === this.activeGatewayId) {
      this.currentModelCatalog = catalog
    }
    return catalog
  }

  getModelContextConfigRpc(): Promise<AgentModelContextSnapshotResult> {
    const recovery = this.modelSelectionCoordinator.getRecoveryState()
    return Promise.resolve({
      ok: true,
      data: {
        ...this.runtimeSettings.confirmed,
        recoveryRequired: recovery.recoveryRequired,
        ...(recovery.error ? { recoveryError: recovery.error } : {}),
      },
    })
  }

  /**
   * Applies an atomic Gateway/model/context selection. This is the only
   * selection entry point; the coordinator owns ordering and rollback.
   */
  applyModelSelectionRpc(
    payload: AgentModelSelectionApplyPayload,
  ): Promise<AgentModelSelectionApplyResult> {
    const modelSelectionPayload: AgentModelSelectionApplyPayload = {
      ...payload,
      contextSource: 'model-selection',
    }
    const reservation = this.modelSelectionCoordinator.reserveIntentSequence(
      'renderer-selection',
      modelSelectionPayload.requestVersion,
    )
    return this.enqueueLifecycleOperation(
      () => this.modelSelectionCoordinator.apply(
        modelSelectionPayload,
        reservation,
      ),
    )
  }

  /**
   * Compatibility adapter for the existing Context IPC. Gateway/model routing
   * is now selected atomically instead of owning a second restart transaction.
   */
  applyModelContextRpc(
    payload: AgentModelContextApplyPayload,
  ): Promise<AgentModelContextApplyResult> {
    const persistedModelId = this.providerStore.loadSync().selectedModelId
    const contextPayload: AgentModelSelectionApplyPayload = {
      gatewayId: this.activeGatewayId,
      modelId: payload.model,
      contextWindow: payload.contextWindow,
      catalogRevision: this.currentModelCatalog.revision,
      threadId: payload.threadId,
      requestVersion: payload.requestVersion,
      contextSource: payload.model.trim() === persistedModelId
        ? 'context-only'
        : 'model-selection',
    }
    // NOTE: the renderer's Context clicks run on their OWN monotonic counter
    // (`modelContextRequestSequence`), independent from model switches. Reserve
    // under the dedicated source so the two counters never cross-invalidate.
    const reservation = this.modelSelectionCoordinator.reserveIntentSequence(
      'renderer-context',
      contextPayload.requestVersion,
    )
    return this.enqueueLifecycleOperation(
      () => this.modelSelectionCoordinator.apply(contextPayload, reservation),
    ).then((result) => mapSelectionResultToContextResult(result, payload))
  }

  /**
   * Explicitly verifies and clears a poisoned model-selection runtime.
   * Recovery is serialized with Provider/turn admission and never commits the
   * saved durable snapshot until the forced restart is healthy and has a new
   * backend generation.
   */
  recoverModelSelectionRpc(): Promise<AgentModelSelectionRecoveryResult> {
    return this.enqueueLifecycleOperation(async () => {
      if (
        this.backend.hasInFlightWork?.()
        ?? this.backend.hasActiveTurns?.()
        ?? false
      ) {
        return {
          ok: false,
          error: '模型恢复需等待当前请求或回合结束。',
          stage: 'busy',
          retryable: true,
          recoveryRequired:
            this.modelSelectionCoordinator.getRecoveryState().recoveryRequired,
        }
      }
      return this.modelSelectionCoordinator.recover()
    })
  }

  private async modelSelectionSnapshot(
    threadId?: string,
  ): Promise<AgentModelSelectionSnapshot> {
    const persisted = this.providerStore.loadSync()
    // Prefer the full routing snapshot (Plan B): it carries the thread's
    // gatewayId/modelProvider binding so the coordinator can detect
    // already-bound threads and same-gateway in-process routes. Legacy stores
    // without the routing reader fall back to the model-only snapshot.
    const thread = threadId
      ? await (this.store?.getThreadRoutingSnapshot)?.(threadId)
        ?? await (this.store?.getThreadModelSnapshot)?.(threadId)
        ?? { exists: true as const, model: persisted.selectedModelId }
      : undefined
    return {
      gatewayId: this.activeGatewayId,
      channelId: this.channelController.currentChannelId(),
      modelId: persisted.selectedModelId,
      ...(thread ? { thread } : {}),
      contextWindow: this.runtimeSettings.confirmed.modelContextWindow,
      autoCompactTokenLimit:
        this.runtimeSettings.confirmed.modelAutoCompactTokenLimit,
      catalogRevision: this.currentModelCatalog.revision,
      backendEpoch: this.backend.currentEpoch?.(),
      threadRestored: false,
    }
  }

  private validateModelSelectionIntent(
    payload: AgentModelSelectionApplyPayload,
    modelId: string,
    channelId: string,
  ): string | null {
    const catalog = this.currentModelCatalog
    if (catalog.gatewayId !== payload.gatewayId) {
      return '模型目录网关已变更，请重新选择。'
    }
    const entry = catalog.models.find((model) => model.id === modelId)
    if (!entry || entry.route.channelId !== channelId) {
      return '所选模型不在当前目录中，请重新选择。'
    }
    if (entry.availability.status !== 'available') {
      return entry.availability.reason
    }
    if (!entry.capabilities.contextOptions.some(
      (option) => option.value === payload.contextWindow,
    )) {
      return `Context window ${String(payload.contextWindow)} is not supported for model ${modelId}`
    }
    return null
  }

  private resolveModelSelectionContext(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
  ): number {
    if (payload.contextSource === 'context-only') return payload.contextWindow
    const entry = this.currentModelCatalog.models.find(
      (model) => model.id === payload.modelId,
    )
    if (!entry) return payload.contextWindow
    const supported = new Set(
      entry.capabilities.contextOptions.map((option) => option.value),
    )
    if (supported.has(previous.contextWindow)) return previous.contextWindow
    if (supported.has(payload.contextWindow)) return payload.contextWindow
    return entry.capabilities.defaultContextWindow
  }

  /**
   * Launch pin the next Codex spawn must use. During a context transition the
   * explicit in-flight pin wins; otherwise the pin is derived from the
   * committed model + context selection, so models running at their
   * Codex-native window launch without `model_context_window` overrides.
   */
  private currentContextPin(): CodexModelContextConfig | null {
    if (this.pendingContextPin !== undefined) {
      return this.pendingContextPin === null
        ? null
        : { ...this.pendingContextPin }
    }
    const window = (
      this.runtimeSettings.pending?.target ?? this.runtimeSettings.confirmed
    ).modelContextWindow
    const pin = resolveModelContextPin(
      this.providerStore.loadSync().selectedModelId,
      window,
    )
    return pin === null ? null : { ...pin }
  }

  private async applyRuntimeModelContext(
    contextWindow: number,
    requestVersion: number,
    pin: CodexModelContextConfig | null,
  ): Promise<void> {
    if (
      this.runtimeSettings.confirmed.modelContextWindow === contextWindow
      && !this.runtimeSettings.pending
      && modelContextPinsEqual(pin, this.currentContextPin())
    ) {
      return
    }
    const target = {
      modelContextWindow: contextWindow,
      modelAutoCompactTokenLimit: Math.floor(contextWindow * 0.9),
    }
    this.pendingContextPin = pin
    this.runtimeSettings = {
      version: 1,
      confirmed: { ...this.runtimeSettings.confirmed },
      pending: {
        target,
        requestVersion,
        startedAt: new Date().toISOString(),
      },
    }
    await this.runtimeSettingsStore.replace(this.runtimeSettings)
    if (!this.backend.isHealthy()) return
    const restart = this.backend.restartCodex?.bind(this.backend)
    if (!restart) throw new Error('Codex restart API is unavailable')
    await this.restartBackendWithGenerationCheck(restart)
    if (!this.backend.isHealthy()) {
      throw new Error('Context restart completed without a healthy backend')
    }
  }

  private async persistModelSelection(
    snapshot: AgentModelSelectionSnapshot,
    threadId?: string,
  ): Promise<void> {
    await this.providerStore.setSelectedGatewayId(snapshot.gatewayId)
    await this.providerStore.setSelectedModelId(snapshot.modelId)
    const settings: PersistedCodexRuntimeSettingsV1 = {
      version: 1,
      confirmed: {
        modelContextWindow: snapshot.contextWindow,
        modelAutoCompactTokenLimit: snapshot.autoCompactTokenLimit,
      },
    }
    await this.runtimeSettingsStore.replace(settings)
    if (threadId) {
      // Plan B: commit the full thread→Channel binding so this conversation
      // stays pinned to its provider even after the GLOBAL selection moves on.
      if (this.store?.setThreadRouting) {
        await this.store.setThreadRouting(threadId, {
          model: snapshot.modelId,
          gatewayId: snapshot.gatewayId,
          modelProvider: snapshot.channelId,
        })
      } else {
        await this.store?.setThreadModel?.(threadId, snapshot.modelId)
      }
    }
    this.runtimeSettings = cloneRuntimeSettings(settings)
    // Selection committed: spawns can derive the pin from the durable
    // model + context selection again.
    this.pendingContextPin = undefined
    this.activeGatewayId = snapshot.gatewayId
  }

  private async restoreModelSelection(
    snapshot: AgentModelSelectionSnapshot,
    threadId?: string,
  ): Promise<void> {
    await this.providerStore.setSelectedGatewayId(snapshot.gatewayId)
    await this.providerStore.setSelectedModelId(snapshot.modelId)
    const settings: PersistedCodexRuntimeSettingsV1 = {
      version: 1,
      confirmed: {
        modelContextWindow: snapshot.contextWindow,
        modelAutoCompactTokenLimit: snapshot.autoCompactTokenLimit,
      },
    }
    await this.runtimeSettingsStore.replace(settings)
    if (threadId) {
      const threadModel = snapshot.thread?.exists
        ? snapshot.thread.model
        : snapshot.modelId
      if (threadModel === null) {
        throw new Error(
          `Cannot restore an unset model for thread ${threadId}`,
        )
      }
      const previousBinding = snapshot.thread?.exists ? snapshot.thread : null
      // Rollback restores the thread's PREVIOUS routing binding when it had
      // one; legacy (null) bindings restore the model column alone so the row
      // keeps its "unbound → derive from active gateway" semantics.
      if (
        this.store?.setThreadRouting
        && previousBinding?.gatewayId != null
        && previousBinding.modelProvider != null
      ) {
        await this.store.setThreadRouting(threadId, {
          model: threadModel,
          gatewayId: previousBinding.gatewayId,
          modelProvider: previousBinding.modelProvider,
        })
      } else {
        await this.store?.setThreadModel?.(
          threadId,
          threadModel,
        )
      }
    }
    this.runtimeSettings = cloneRuntimeSettings(settings)
    // Rollback restored the previous durable selection; drop any in-flight pin.
    this.pendingContextPin = undefined
    this.activeGatewayId = snapshot.gatewayId
  }

  /**
   * Proves the saved recovery identity still resolves against durable providers.
   * A DB thread deleted while poisoned is intentionally not resurrected.
   */
  private async validateModelSelectionRecovery(
    snapshot: AgentModelSelectionSnapshot,
    threadId?: string,
  ): Promise<{
    snapshot: AgentModelSelectionSnapshot
    threadId?: string
  }> {
    const persisted = await this.providerStore.load()
    const route = resolveGatewayModelRoute(
      snapshot.gatewayId,
      snapshot.modelId,
      persisted.customProviders,
    )
    if (route.channelId !== snapshot.channelId) {
      throw new Error(
        `Saved recovery Channel ${snapshot.channelId} no longer matches Gateway ${snapshot.gatewayId}`,
      )
    }
    const currentThread = threadId
      ? await this.store?.getThreadModelSnapshot?.(threadId)
      : undefined
    const thread = currentThread ?? snapshot.thread
    return {
      snapshot: {
        ...snapshot,
        ...(thread ? { thread } : {}),
      },
      ...(
        threadId && thread?.exists !== false
          ? { threadId }
          : {}
      ),
    }
  }

  /**
   * Rebuilds the catalog only after the saved Channel has a verified runtime.
   * Poison clears only when the refreshed catalog still belongs to that
   * Gateway and can actually serve the saved selection: the saved model must
   * exist, route to the saved Channel, be available, and support the saved
   * Context. Returns the refreshed revision for the recovery snapshot.
   */
  private async refreshModelSelectionRecoveryCatalog(
    snapshot: AgentModelSelectionSnapshot,
  ): Promise<{ catalogRevision: string }> {
    const catalog = await this.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    if (catalog.data.gatewayId !== snapshot.gatewayId) {
      throw new Error(
        `Recovery catalog Gateway ${catalog.data.gatewayId} does not match ${snapshot.gatewayId}`,
      )
    }
    const entry = catalog.data.models.find(
      (model) => model.id === snapshot.modelId,
    )
    if (!entry) {
      throw new Error(
        `Recovery catalog for ${snapshot.gatewayId} no longer contains model ${snapshot.modelId}`,
      )
    }
    if (entry.route.channelId !== snapshot.channelId) {
      throw new Error(
        `Recovery model ${snapshot.modelId} now routes to Channel ${entry.route.channelId} instead of ${snapshot.channelId}`,
      )
    }
    if (entry.availability.status !== 'available') {
      throw new Error(
        `Recovery model ${snapshot.modelId} is unavailable: ${entry.availability.reason}`,
      )
    }
    const contextSupported = entry.capabilities.contextOptions.some(
      (option) => option.value === snapshot.contextWindow,
    )
    if (!contextSupported) {
      throw new Error(
        `Recovery context window ${String(snapshot.contextWindow)} is not supported for model ${snapshot.modelId}`,
      )
    }
    this.currentModelCatalog = catalog.data
    return { catalogRevision: catalog.data.revision }
  }

  private async resumeSelectedThread(
    threadId: string,
    target?: AgentModelSelectionRouteTarget,
  ): Promise<void> {
    const persistedThreadId = this.codexThreadIdByDbThreadId.get(threadId)
      ?? await this.store?.getCodexThreadId?.(threadId)
      ?? undefined
    if (!persistedThreadId) return
    if (target) {
      await this.rebindThreadInProcess(threadId, persistedThreadId, target)
      return
    }
    if (!this.backend.resumeThread) {
      throw new Error('Codex strict thread resume API is unavailable')
    }
    await this.backend.resumeThread(persistedThreadId)
    this.codexThreadIdByDbThreadId.set(threadId, persistedThreadId)
    const epoch = this.backend.currentEpoch?.()
    if (epoch !== undefined) {
      this.codexThreadEpochByDbThreadId.set(threadId, epoch)
    }
    await this.store?.setCodexThreadId?.(threadId, persistedThreadId)
    // The only re-establish path that does not funnel through
    // `rememberCodexThread`, so it needs its own re-assert.
    this.reassertThreadMemoryMode(threadId, persistedThreadId)
  }

  /**
   * Plan B in-process routing: move a conversation onto the TARGET sibling
   * provider table by FORKING its codex thread with `model`/`modelProvider`
   * (+ thread-scoped context pin) overrides.
   *
   * Why fork, not resume: `thread/resume` on a LOADED thread silently IGNORES
   * model/modelProvider overrides (upstream `resume_running_thread` — a
   * subscribed live thread "rejoins" with its old config; verified against
   * the bundled binary by scripts/smoke-live-thread-provider-switch.ts). That
   * no-op left the codex session on the OLD provider while turns carried the
   * NEW model, producing crossed requests like "端点/codex未配置模型grok-4.5".
   * Upstream's position is that mid-thread provider switches must start a new
   * thread (openai/codex#18964); `thread/fork` is exactly that with the full
   * history copied, and its overrides route the fork like `thread/start`.
   */
  private async rebindThreadInProcess(
    dbThreadId: string,
    codexThreadId: string,
    target: AgentModelSelectionRouteTarget,
  ): Promise<void> {
    if (!this.backend.forkThread) {
      throw new Error('Codex thread fork API is unavailable')
    }
    const pin = resolveModelContextPin(target.modelId, target.contextWindow)
    const overrides: CodexThreadConfigOverrides = {
      model: target.modelId,
      modelProvider: target.channelId,
      ...(pin
        ? {
            config: {
              model_context_window: pin.modelContextWindow,
              model_auto_compact_token_limit: pin.modelAutoCompactTokenLimit,
            },
          }
        : {}),
    }
    let forked: CodexThreadSummary
    try {
      forked = await this.backend.forkThread(codexThreadId, overrides)
    } catch (error) {
      if (isMissingRolloutError(error)) {
        // Turnless thread (started but never completed a turn) — there is no
        // rollout to fork and no history to lose. Drop the mapping so the next
        // send opens a FRESH thread that rides the new binding's
        // `modelProvider` via thread/start.
        this.forgetCodexThread(dbThreadId)
        return
      }
      throw error
    }
    // Best-effort: drop our subscription on the abandoned source thread so
    // codex can unload it after its idle window (subscribed threads are
    // pinned in memory forever).
    void Promise.resolve(this.backend.unsubscribeThread?.(codexThreadId))
      .catch((err: unknown) => {
        console.warn('[AgentManager] thread/unsubscribe after rebind fork failed:', err)
      })
    // Re-point the conversation at the fork (map + epoch tag + persistence).
    // The target Channel is passed explicitly because the new binding is not
    // persisted yet — see `threadChannelSupportsMemories`.
    this.rememberCodexThread(dbThreadId, forked.id, target.channelId)
  }

  /**
   * Builds the canonical fallback catalog for `gatewayId` — the same
   * user-visible Gateway id used by the live Codex `model/list` path, never
   * an internal Channel id. `buildGatewayModelCatalog()` resolves each
   * canonical row's route and marks its context options conservative itself
   * (via `dynamicSource: 'fallback'`); this method only supplies the raw
   * canonical rows and availability.
   */
  private fallbackModelSettingsCatalog(
    gatewayId: string,
    customProviders: readonly ProviderPreset[],
  ): AgentModelSettingsCatalog {
    return buildGatewayModelCatalog({
      gatewayId,
      dynamicSource: 'fallback',
      dynamicModels: CANONICAL_MODEL_SETTINGS_ROWS.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        description: row.description,
        hidden: false,
        isDefault: row.isDefault,
      })),
      customProviders,
      hasCredential: (credentialId) => this.hasCredentialFor(credentialId),
      availabilityByModel: this.modelAvailabilityByGateway.get(gatewayId)
        ?? new Map(),
    })
  }

  /**
   * 某个凭据槽配好了没有。
   *
   * 当前网关那枚走内存副本 `codexApiKey`（它随 provider 事务实时更新，比回读
   * store 准）；其余槽位（qwen/Miau 等借用别处凭据的通道）回落到持久化的
   * `apiKeys`。不这么分的话，只配了 Miau 密钥的用户会看到 qwen 模型被标成
   * 「请先配置网关 Key」——一枚它们根本不用的密钥。
   */
  private hasCredentialFor(credentialId: string): boolean {
    const persisted = this.providerStore.loadSync()
    const activeCredentialId = credentialIdForProvider(
      this.activeGatewayId,
      persisted.customProviders,
    )
    if (credentialId === activeCredentialId) return Boolean(this.codexApiKey)
    return Boolean((persisted.apiKeys[credentialId] ?? '').trim())
  }

  private modelRoute(providerId: string, modelId: string) {
    const persisted = this.providerStore.loadSync()
    const gatewayId = credentialIdForProvider(providerId, persisted.customProviders)
    return resolveGatewayModelRoute(gatewayId, modelId, persisted.customProviders)
  }

  async getCollaborationCapabilitiesRpc(
    modelId: string,
  ): Promise<AgentCollaborationCapabilitiesResult> {
    try {
      const resolved = await this.resolveCollaborationCapabilities(modelId, true)
      return {
        ok: true,
        data: resolved.capabilities,
      }
    } catch {
      return {
        ok: true,
        data: this.fallbackCollaborationCapabilities(
          this.channelController.currentChannelId(),
          this.backend.currentEpoch?.(),
        ),
      }
    }
  }

  private fallbackCollaborationCapabilities(
    providerId: string,
    backendEpoch: number | undefined,
  ): AgentCollaborationCapabilities {
    return {
      providerId,
      gatewayId: this.activeGatewayId,
      ...(backendEpoch === undefined ? {} : { backendEpoch }),
      planDefaultEffort: null,
      supportedPlanEfforts: [],
      source: 'fallback',
    }
  }

  private async resolveCollaborationCapabilities(
    modelId: string,
    includePlanPreset: boolean,
  ): Promise<ResolvedCollaborationCapabilities> {
    let restartBarrier = this.restartChain
    await restartBarrier
    while (restartBarrier !== this.restartChain) {
      restartBarrier = this.restartChain
      await restartBarrier
    }
    let providerBarrier = this.providerCapabilityBarrier
    let providerReady = await providerBarrier
    while (providerBarrier !== this.providerCapabilityBarrier) {
      providerBarrier = this.providerCapabilityBarrier
      providerReady = await providerBarrier
    }
    return this.resolveCollaborationCapabilitiesForCurrentOwner(
      modelId,
      includePlanPreset,
      providerReady,
    )
  }

  /**
   * PRECONDITION: the caller owns the Provider/turn admission lifecycle slot.
   * That slot already excludes Provider apply, so reacquiring restartChain here
   * would wait on the caller itself. Only send admission internals may use this.
   */
  private resolveCollaborationCapabilitiesWithProviderAdmissionHeld(
    modelId: string,
    includePlanPreset: boolean,
  ): Promise<ResolvedCollaborationCapabilities> {
    return this.resolveCollaborationCapabilitiesForCurrentOwner(
      modelId,
      includePlanPreset,
      true,
    )
  }

  private async resolveCollaborationCapabilitiesForCurrentOwner(
    modelId: string,
    includePlanPreset: boolean,
    providerReady: boolean,
  ): Promise<ResolvedCollaborationCapabilities> {
    const providerId = this.channelController.currentChannelId()
    const backendEpoch = this.backend.currentEpoch?.()
    const fallback = (): ResolvedCollaborationCapabilities => ({
      model: modelId,
      capabilities: this.fallbackCollaborationCapabilities(providerId, backendEpoch),
    })
    const ownerStillCurrent = (): boolean =>
      this.channelController.currentChannelId() === providerId
      && (
        backendEpoch === undefined
        || this.backend.currentEpoch?.() === backendEpoch
      )

    if (!providerReady || typeof this.backend.listModels !== 'function') return fallback()

    try {
      const [models, planPresetEffort] = await Promise.all([
        this.backend.listModels({ includeHidden: true }),
        includePlanPreset
          ? this.planPresetReasoningEffort()
          : Promise.resolve<string | null>(null),
      ])
      if (!ownerStillCurrent()) {
        throw new Error('Collaboration capability owner changed while loading')
      }
      const modelRow =
        models.data.find((row) => row.id === modelId)
        ?? models.data.find((row) => row.model === modelId)
      // Channel-declared models (e.g. grok-4.5 pinned via `allowedModels`)
      // never appear in codex `model/list` rows. Mirror the model settings
      // catalog's declared-model path so their verified reasoning policies
      // still surface as Plan effort options instead of a hard fallback.
      let model: string
      let dynamicReasoning: {
        defaultReasoningEffort?: string
        supportedReasoningEfforts?: readonly string[]
      }
      if (modelRow) {
        model = modelRow.model
        dynamicReasoning = {
          defaultReasoningEffort: modelRow.defaultReasoningEffort,
          supportedReasoningEfforts: modelRow.supportedReasoningEfforts.map(
            (effort) => effort.reasoningEffort,
          ),
        }
      } else {
        model = modelId.trim()
        dynamicReasoning = {}
      }
      const route = this.modelRoute(providerId, model)
      if (!modelRow) {
        const declaredChannel = resolveProviderChannel(
          route.channelId,
          this.providerStore.loadSync().customProviders,
        )
        const declared =
          declaredChannel.allowedModels?.includes(model)
          || declaredChannel.extraCatalogModels?.includes(model)
        if (!declared) return fallback()
      }
      const modelSettings = mergeModelSettingsCapabilities({
        model,
        gatewayId: route.gatewayId,
        channelId: route.channelId,
        ...dynamicReasoning,
      })
      const supportedPlanEfforts = modelSettings.supportedReasoningEfforts
      const preferredDefault = resolvePlanReasoningEffort('auto', planPresetEffort)
      const planDefaultEffort: ConcretePlanReasoningEffort | null =
        supportedPlanEfforts.includes(preferredDefault)
          ? preferredDefault
          : supportedPlanEfforts.includes('medium')
            ? 'medium'
            : supportedPlanEfforts[0] ?? null

      return {
        model,
        capabilities: {
          providerId,
          gatewayId: route.gatewayId,
          ...(backendEpoch === undefined ? {} : { backendEpoch }),
          planDefaultEffort,
          supportedPlanEfforts,
          source: 'codex',
        },
      }
    } catch (error) {
      if (!ownerStillCurrent()) throw error
      return fallback()
    }
  }

  async updateCollaborationModeRpc(
    payload: AgentCollaborationModeUpdatePayload,
  ): Promise<AgentCollaborationModeUpdateResult> {
    if (typeof this.backend.updateThreadSettings !== 'function') {
      return {
        ok: false,
        error: 'Codex thread settings update API is unavailable',
        requestVersion: payload.requestVersion,
      }
    }
    const updateThreadSettings = this.backend.updateThreadSettings.bind(this.backend)
    let builtCollaborationMode: BuiltCollaborationMode
    try {
      builtCollaborationMode = await this.buildCollaborationMode(
        payload.mode,
        payload.model,
        payload.defaultReasoningEffort,
        payload.planReasoningEffort,
      )
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        requestVersion: payload.requestVersion,
      }
    }
    this.syncCollaborationProcessCaches()
    if (this.threadSettingsUpdateSupport === 'unsupported') {
      return {
        ok: true,
        data: {
          compatibility: 'next-turn',
          requestVersion: payload.requestVersion,
        },
      }
    }
    // Reuse the normal send path's generation-aware resolver. It resumes a
    // stale/persisted Codex thread after an app-server respawn (including a
    // full desktop restart) but never creates a replacement thread merely to
    // persist a mode toggle.
    const codexThreadId = await this.resolveCodexThreadForSend(payload.threadId)
    if (!codexThreadId) {
      return {
        ok: false,
        error: `No resumable Codex thread exists for DB thread ${payload.threadId}`,
        requestVersion: payload.requestVersion,
      }
    }

    try {
      builtCollaborationMode = await this.stabilizeCollaborationMode(
        builtCollaborationMode,
        payload.mode,
        payload.model,
        payload.defaultReasoningEffort,
        payload.planReasoningEffort,
      )
      await this.commitWithCollaborationModeOwner(
        builtCollaborationMode,
        () => updateThreadSettings({
          threadId: codexThreadId,
          collaborationMode: builtCollaborationMode.collaborationMode,
        }),
      )
      this.syncCollaborationProcessCaches()
      this.threadSettingsUpdateSupport = 'supported'
      return {
        ok: true,
        data: {
          compatibility: 'immediate',
          requestVersion: payload.requestVersion,
        },
      }
    } catch (error) {
      if (isUnsupportedThreadSettingsUpdate(error)) {
        this.syncCollaborationProcessCaches()
        this.threadSettingsUpdateSupport = 'unsupported'
        return {
          ok: true,
          data: {
            compatibility: 'next-turn',
            requestVersion: payload.requestVersion,
          },
        }
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        requestVersion: payload.requestVersion,
      }
    }
  }

  listMcpServersRpc = this.backendRpc.listMcpServers
  batchWriteConfigRpc = this.backendRpc.batchWriteConfig
  writeConfigValueRpc = this.backendRpc.writeConfigValue
  readConfigRpc = this.backendRpc.readConfig

  readRawConfigRpc = this.backendRpc.readRawConfig
  reloadMcpServersRpc = this.backendRpc.reloadMcpServers
  mcpOAuthLoginRpc = this.backendRpc.mcpOAuthLogin

  // ─── Native `/goal` + `/compact` (thread/goal/*, thread/compact/*) ─────────
  // Renderer passes the DB thread id; we resolve it to the codex thread id
  // (in-memory map, falling back to the persisted id) before hitting the
  // app-server. All wrap in the standard `{ ok, error?, data? }` envelope.

  private async resolveCodexThreadIdForRpc(dbThreadId: string): Promise<string | undefined> {
    const inMem = this.codexThreadIdByDbThreadId.get(dbThreadId)
    if (inMem) return inMem
    try {
      return (await this.store?.getCodexThreadId?.(dbThreadId)) ?? undefined
    } catch {
      return undefined
    }
  }

  async setThreadGoalRpc(
    dbThreadId: string,
    params: { objective?: string; tokenBudget?: number; status?: ThreadGoalStatus },
  ): Promise<GoalRpcResult<ThreadGoal>> {
    try {
      if (!this.backend.setThreadGoal) throw new Error('Goal API unavailable')
      const codexThreadId = await this.resolveCodexThreadIdForRpc(dbThreadId)
      if (!codexThreadId) {
        return { ok: false, error: '先发一条消息创建会话,再设置目标(/goal)。' }
      }
      const res = await this.backend.setThreadGoal({ threadId: codexThreadId, ...params })
      return { ok: true, data: res.goal }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async getThreadGoalRpc(dbThreadId: string): Promise<GoalRpcResult<ThreadGoal | null>> {
    try {
      if (!this.backend.getThreadGoal) throw new Error('Goal API unavailable')
      const codexThreadId = await this.resolveCodexThreadIdForRpc(dbThreadId)
      if (!codexThreadId) return { ok: true, data: null }
      const res = await this.backend.getThreadGoal(codexThreadId)
      return { ok: true, data: res.goal }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async clearThreadGoalRpc(dbThreadId: string): Promise<GoalRpcResult<{ cleared: boolean }>> {
    try {
      if (!this.backend.clearThreadGoal) throw new Error('Goal API unavailable')
      const codexThreadId = await this.resolveCodexThreadIdForRpc(dbThreadId)
      if (!codexThreadId) return { ok: true, data: { cleared: false } }
      const res = await this.backend.clearThreadGoal(codexThreadId)
      return { ok: true, data: { cleared: res.cleared } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Kick off REAL native history compaction (thread/compact/start). Resolves
   * once the app-server accepts the request; actual progress streams back as a
   * `contextCompaction` activity item (started→completed) over the normal
   * event channel. Requires an existing codex thread (send a message first).
   */
  async compactThreadRpc(dbThreadId: string): Promise<GoalRpcResult<{ started: boolean }>> {
    try {
      if (!this.backend.compactThread) throw new Error('Compact API unavailable')
      const codexThreadId = await this.resolveCodexThreadIdForRpc(dbThreadId)
      if (!codexThreadId) {
        return { ok: false, error: '先发一条消息创建会话,再压缩上下文(/compact)。' }
      }
      await this.backend.compactThread(codexThreadId)
      return { ok: true, data: { started: true } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ─── Cross-session memory (thread/memoryMode/set + memory/reset) ──────────
  // Both are `#[experimental]` @ rust-v0.145.0 and reachable because the
  // production backend announces `experimentalApi: true` at initialize.

  /**
   * Record the user's memory choice for one thread and apply it if possible.
   *
   * This is the renderer-facing entry point, and unlike
   * {@link setThreadMemoryModeRpc} it succeeds on a thread that has no codex
   * thread yet — the common case, since "don't remember this one" is a decision
   * users make *before* typing. The choice is persisted, and
   * {@link reassertThreadMemoryMode} replays it onto every codex thread this
   * conversation is later given (first start, fork, rebind, restart-resume).
   *
   * `pushed` reports whether the backend already has the mode, so callers can
   * distinguish "saved, takes effect on send" from "live now".
   */
  async declareThreadMemoryModeRpc(
    dbThreadId: string,
    mode: CodexThreadMemoryMode,
  ): Promise<{ ok: boolean; error?: string; pushed?: boolean }> {
    try {
      if (mode !== 'enabled' && mode !== 'disabled') {
        return { ok: false, error: `invalid memory mode: ${String(mode)}` }
      }
      if (!this.store?.setThreadMemoryMode) {
        return { ok: false, error: 'Thread store unavailable' }
      }
      await this.store.setThreadMemoryMode(dbThreadId, mode)
      // Pushing is opportunistic: no codex thread yet is normal, not an error.
      const codexThreadId = this.codexThreadIdByDbThreadId.get(dbThreadId)
        ?? await this.store?.getCodexThreadId?.(dbThreadId)
        ?? undefined
      if (!codexThreadId || !this.backend.setThreadMemoryMode) {
        return { ok: true, pushed: false }
      }
      await this.backend.setThreadMemoryMode(codexThreadId, mode)
      return { ok: true, pushed: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Replay a thread's persisted memory choice onto a codex thread that was just
   * established. Called from every path that mints or re-establishes a codex
   * thread id, because the protocol offers no way to READ the current mode back
   * — so we cannot tell whether a resumed rollout still carries the earlier
   * `thread/memoryMode/set`. Re-asserting is idempotent, so the safe move is to
   * assume it does not.
   *
   * A Channel that cannot produce well-formed artifacts overrides the choice:
   * see {@link threadChannelSupportsMemories} for why the launch flag alone
   * does not cover it.
   *
   * Fire-and-forget by design: it rides the streaming hot path, and a thread
   * that fails to re-assert falls back to the codex default rather than
   * breaking the turn.
   */
  private reassertThreadMemoryMode(
    dbThreadId: string,
    codexThreadId: string,
    channelIdHint?: string,
  ): void {
    if (!this.backend.setThreadMemoryMode) return
    void (async () => {
      try {
        if (!await this.threadChannelSupportsMemories(dbThreadId, channelIdHint)) {
          // Deliberately NOT written through to the store: this is the
          // Channel's constraint, not the user's decision, so the persisted
          // choice stays intact and applies again on a capable Channel.
          await this.backend.setThreadMemoryMode?.(codexThreadId, 'disabled')
          return
        }
        const mode = await this.store?.getThreadMemoryMode?.(dbThreadId)
        if (mode !== 'enabled' && mode !== 'disabled') return
        await this.backend.setThreadMemoryMode?.(codexThreadId, mode)
      } catch (err) {
        console.warn('[AgentManager] failed to re-assert thread memory mode:', err)
      }
    })()
  }

  /**
   * Whether the Channel this thread runs on may take part in cross-session
   * memory (see {@link CodexProviderConfig.supportsMemories}).
   *
   * Needed because `features.memories` is a launch flag: a Channel's `false`
   * only reaches Codex when that Channel is active AT SPAWN. Every sibling
   * Channel of the active Gateway is registered on the same spawn, so
   * selecting one is served by in-process routing with no restart (see
   * `canRouteInProcess`) — a thread can therefore run on a Claude Channel
   * inside a process launched with memories ON, which is exactly the case the
   * flag was meant to prevent. Per-thread mode is the only lever that follows
   * the binding instead of the process.
   *
   * `channelIdHint` wins when given: a rebind forks onto the target Channel
   * before the new binding is persisted, so the store would still name the
   * OUTGOING one. Otherwise the persisted binding decides, and an unbound
   * thread falls back to the active Channel — which is what it will run on.
   * An unresolvable Channel is treated as capable: a Channel we cannot read
   * is not evidence of a restriction, and the launch flag still applies.
   */
  private async threadChannelSupportsMemories(
    dbThreadId: string,
    channelIdHint?: string,
  ): Promise<boolean> {
    let channelId = channelIdHint
    if (!channelId) {
      try {
        const routing = await this.store?.getThreadRoutingSnapshot?.(dbThreadId)
        channelId = routing?.exists ? routing.modelProvider ?? undefined : undefined
      } catch {
        channelId = undefined
      }
    }
    channelId ??= this.channelController.currentChannelId()
    try {
      const channel = resolveProviderChannel(
        channelId,
        this.providerStore.loadSync().customProviders,
      )
      return channel.supportsMemories !== false
    } catch {
      return true
    }
  }

  /**
   * Toggle memory eligibility for ONE thread. `mode` crosses the IPC boundary
   * as untrusted input, so it is validated here before touching the backend.
   */
  async setThreadMemoryModeRpc(
    dbThreadId: string,
    mode: CodexThreadMemoryMode,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      if (mode !== 'enabled' && mode !== 'disabled') {
        return { ok: false, error: `invalid memory mode: ${String(mode)}` }
      }
      if (!this.backend.setThreadMemoryMode) throw new Error('Memory mode API unavailable')
      const codexThreadId = await this.resolveCodexThreadIdForRpc(dbThreadId)
      if (!codexThreadId) {
        return { ok: false, error: '先发一条消息创建会话,再调整该会话的记忆模式。' }
      }
      await this.backend.setThreadMemoryMode(codexThreadId, mode)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Wipe the global `$CODEX_HOME/memories/` store (`memory/reset`). Global —
   * no thread id; the settings panel gates it behind a two-step confirm.
   */
  async resetMemoryRpc(): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.backend.resetMemory) throw new Error('Memory reset API unavailable')
      await this.backend.resetMemory()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ─── Native plugin / marketplace / apps / external-agent-import (≥0.140) ───
  // Each delegates to the backend passthrough and wraps the result in the
  // standard `{ ok, error?, data? }` envelope so the renderer never has to
  // try/catch across the IPC boundary. The "API unavailable" guard fires when
  // the active backend is non-Codex or hasn't been started yet.

  listPluginsRpc = this.backendRpc.listPlugins
  listInstalledPluginsRpc = this.backendRpc.listInstalledPlugins
  readPluginRpc = this.backendRpc.readPlugin
  installPluginRpc = this.backendRpc.installPlugin
  uninstallPluginRpc = this.backendRpc.uninstallPlugin
  addMarketplaceRpc = this.backendRpc.addMarketplace
  removeMarketplaceRpc = this.backendRpc.removeMarketplace
  upgradeMarketplacesRpc = this.backendRpc.upgradeMarketplaces
  listAppsRpc = this.backendRpc.listApps
  detectExternalAgentConfigRpc = this.backendRpc.detectExternalAgentConfig
  importExternalAgentConfigRpc = this.backendRpc.importExternalAgentConfig

  // ---- Docker MCP Gateway workaround for Codex bug #19425 ----
  // See ./dockerMcpGateway.ts for the full rationale. Renderer calls
  // `dockerGatewayCheck` to gate the "Fix" button, then `dockerGatewayFix`
  // to actually convert + start. Status/stop are exposed for diagnostics.

  async dockerGatewayCheckRpc(): Promise<CheckInstalledResult> {
    return getDockerMcpGatewayService().checkInstalled()
  }

  async dockerGatewayStatusRpc(): Promise<GatewayStatus> {
    return getDockerMcpGatewayService().getStatus()
  }

  async dockerGatewayStopRpc(): Promise<{ ok: boolean; error?: string }> {
    try {
      await getDockerMcpGatewayService().stop()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * One-shot orchestration for the renderer's "一键修复" button. Choreography:
   *   1. Verify `docker mcp` is installed.
   *   2. Read current Codex config; pick out docker-run-based MCP entries.
   *   3. Build a fresh gateway profile containing those images.
   *   4. Spawn the gateway in HTTP/SSE mode on `port` (or default 8811).
   *   5. Replace the docker entries in `mcp_servers` with a single
   *      `[mcp_servers.docker_gw] url = "http://127.0.0.1:<port>/sse"` entry,
   *      then ask Codex to reload its MCP layer.
   *
   * Idempotent — running it again rebuilds the profile from the current set
   * and restarts the gateway. Failures partway through leave config alone:
   * we only mutate `mcp_servers` once we have a healthy gateway.
   */
  async dockerGatewayFixRpc(opts?: { port?: number }): Promise<{
    ok: boolean
    error?: string
    converted?: string[]
    gatewayPort?: number
  }> {
    const port = opts?.port ?? GATEWAY_DEFAULT_PORT
    const svc = getDockerMcpGatewayService()
    try {
      const check = await svc.checkInstalled()
      if (!check.installed) {
        return {
          ok: false,
          error: check.error ?? 'docker mcp 未安装。请先安装 Docker Desktop 4.59+ 或手动安装 docker-mcp CLI plugin。',
        }
      }

      if (!this.backend.readConfig) throw new Error('MCP read config API unavailable')
      if (!this.backend.batchWriteConfig) throw new Error('MCP batch write API unavailable')
      const cfg = await this.backend.readConfig()
      const mcpServers = (cfg?.config as any)?.mcp_servers ?? {}
      const dockerEntries = selectDockerStdioEntries(mcpServers)
      if (dockerEntries.length === 0) {
        return { ok: false, error: '没有找到需要修复的 docker MCP 服务器。' }
      }

      // Build a fresh profile from the current docker entries. We always
      // rebuild rather than diff -- profile lifetime is owned by us, so
      // rebuilding is cheap and avoids stale entries from previous runs.
      const images = Array.from(new Set(dockerEntries.map((e) => e.image)))
      await svc.addServersToProfile(GATEWAY_PROFILE_NAME, images).catch((err) => {
        // Profile may already exist from a previous run -- we don't have
        // a non-destructive update path in `docker mcp` yet, so surface
        // the error so the user can manually clean up. (Future: probe
        // first via `docker mcp profile show` and `profile remove`.)
        if (/already exists/i.test(err?.message ?? '')) {
          throw new Error(
            `Docker MCP profile "${GATEWAY_PROFILE_NAME}" 已存在。请先在终端运行 ` +
            `\`docker mcp profile remove ${GATEWAY_PROFILE_NAME}\` 后重试。`,
          )
        }
        throw err
      })

      // Spawn (or restart) the gateway. `start` stops the previous
      // instance first so this is safe to call repeatedly.
      const status = await svc.start({ port, profile: GATEWAY_PROFILE_NAME })

      // Now mutate config: remove every docker-run server we converted,
      // and add the single URL entry. We use `mergeStrategy: 'replace'`
      // for both so we don't leave half-merged entries behind.
      const edits = dockerEntries.map((e) => ({
        keyPath: `mcp_servers.${e.name}`,
        value: null,
        mergeStrategy: 'replace' as const,
      }))
      edits.push({
        keyPath: `mcp_servers.${GATEWAY_SERVER_NAME}`,
        value: buildGatewayConfigEntry(port) as any,
        mergeStrategy: 'replace' as const,
      })
      await this.backend.batchWriteConfig(edits, true)

      return {
        ok: true,
        converted: dockerEntries.map((e) => e.name),
        gatewayPort: status.port ?? port,
      }
    } catch (err) {
      // Best-effort: if we already started the gateway but the config
      // write blew up, leave the gateway running -- the user can still
      // wire it up manually, and `dockerGatewayStop` is exposed.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async start(): Promise<void> {
    return this.ensureBackendStarted()
  }

  /**
   * Idempotent, deduped backend start. No-op when the backend is already
   * healthy; otherwise spawns codex (sharing one in-flight promise across
   * concurrent callers). Throws the REAL startup error (spawn failure / config
   * error / exit tail) so callers can surface it — instead of the cryptic
   * "CodexLocalBackend.send called before start" that resulted when the
   * bootstrap start() failed and was swallowed, leaving `this.client` null.
   */
  private async ensureBackendStarted(): Promise<void> {
    if (this.backend.isHealthy()) return
    if (!this.startInFlight) {
      // Assign `startInFlight` synchronously (no `await` before this point) so
      // concurrent callers dedupe onto one start. The one-time legacy-session
      // consolidation runs INSIDE that promise, before the spawn, so the
      // upcoming `thread/resume` can find sessions written under the old per-app
      // `codex-runtime` home. Best-effort: migration never rejects the start.
      this.startInFlight = (async () => {
        await this.migrateLegacyCodexSessionsOnce()
        await this.backend.start()
      })().finally(() => {
        this.startInFlight = null
      })
    }
    return this.startInFlight
  }

  /**
   * One-time, best-effort consolidation of codex session rollouts into the
   * pinned `CODEX_HOME`. Recovers conversations whose rollout was written under
   * the legacy per-app `<userData>/codex-runtime/sessions` home (only happened
   * after a provider switch — see `resolveStableCodexHome`). Never throws into
   * the start path; the worst case is an old provider-switched chat that can't
   * resume, which already degrades gracefully to a fresh thread + notice.
   */
  private async migrateLegacyCodexSessionsOnce(): Promise<void> {
    if (this.legacySessionsMigrated) return
    this.legacySessionsMigrated = true
    try {
      const runtimeDir = path.dirname(this.workspacePaths().runtimeConfigToml)
      const legacySessionsDir = path.join(runtimeDir, 'sessions')
      const targetSessionsDir = path.join(resolveStableCodexHome(), 'sessions')
      const result = await migrateLegacyCodexSessions({ legacySessionsDir, targetSessionsDir })
      if (result.moved > 0) {
        console.log(
          `[AgentManager] migrated ${result.moved} legacy codex session rollout(s) into the pinned CODEX_HOME` +
            (result.skipped > 0 ? ` (${result.skipped} already present)` : ''),
        )
      }
    } catch (err) {
      console.warn('[AgentManager] legacy codex session migration failed (best-effort):', err)
    }
  }

  async stop(): Promise<void> {
    await this.backend.stop()
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.codexApiKey) {
      return { ok: false, error: '请先填写 API Key' }
    }
    // Resolve the *currently selected* provider (apiyi / rightcode / custom) so
    // the probe backend talks to the same gateway the main agent does. v4.2.x
    // used to hard-code apiyi here — see DEFAULT_PROVIDER reference removed in
    // v4.3.0 — but with multi-provider that would silently mis-route the test
    // and report success against the wrong host.
    const persisted = await this.providerStore.load()
    const activeProvider = resolvePersistedStartupProvider(persisted).provider
    // Build a fresh, isolated backend so we never disturb the long-lived one.
    // Re-uses the production resourceRoot resolution path inside CodexLocalBackend
    // (app.getAppPath / process.resourcesPath) — the only thing we tighten is
    // the connect timeout so a misconfigured key fails fast instead of waiting
    // the full production budget.
    const backend = new CodexLocalBackend({
      getApiKey: () => this.codexApiKey,
      connectTimeoutMs: 8_000,
      provider: activeProvider,
      sessionConfig: this.sessionConfig,
    })
    const TEST_TIMEOUT_MS = 15_000

    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        backend.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Test connection timeout')), TEST_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
      await backend.stop().catch(() => { /* ignore */ })
    }
  }

  async sendMessage(payload: AgentSendMessagePayload): Promise<AgentSendMessageResult> {
    const reservation = this.modelSelectionCoordinator.reserveIntentSequence(
      'turn',
    )
    return this.enqueueTurnAdmission(
      () => this.sendMessageAfterProviderBarrier(payload, reservation),
    )
  }

  private async turnModelSelectionIntent(
    payload: AgentSendMessagePayload,
    reservation: AgentModelSelectionIntentReservation,
  ): Promise<AgentModelSelectionIntent> {
    const payloadModel = payload.model?.trim()
    if (payload.modelSelection) {
      const intentModel = payload.modelSelection.modelId.trim()
      if (payloadModel && payloadModel !== intentModel) {
        throw new Error(
          `Model selection mismatch: payload model ${payloadModel} does not match confirmed intent ${intentModel}`,
        )
      }
      if (reservation.rendererSelectionSequence > 0) {
        return this.confirmedTurnModelSelectionIntent()
      }
      return {
        ...payload.modelSelection,
        modelId: intentModel,
        contextSource: 'model-selection',
      }
    }

    if (reservation.rendererSelectionSequence > 0) {
      return this.confirmedTurnModelSelectionIntent()
    }

    // Plan B: an EXISTING thread with no explicit selection keeps riding its
    // own persisted binding — sending in a Grok-bound conversation must not
    // silently re-route it just because the GLOBAL selection moved to GPT.
    // Legacy rows (null binding) and models the current catalog can no longer
    // serve fall through to the global selection, exactly as before.
    if (!payloadModel && payload.threadId && this.store) {
      // Optional call: test harnesses inject partial ThreadStore mocks.
      const routing = await this.store.getThreadRoutingSnapshot?.(payload.threadId)
      if (
        routing?.exists
        && routing.model !== null
        && routing.modelProvider !== null
        && (routing.gatewayId === null || routing.gatewayId === this.activeGatewayId)
        && this.currentModelCatalog.models.some(
          (model) => model.id === routing.model,
        )
      ) {
        return this.modelSelectionIntentForModel(routing.model)
      }
    }

    const persisted = this.providerStore.loadSync()
    const modelId = payloadModel || persisted.selectedModelId
    return this.modelSelectionIntentForModel(modelId)
  }

  /**
   * Builds a turn intent from the active confirmed selection after a renderer
   * selection was already reserved, so stale legacy payloads cannot route back.
   */
  private confirmedTurnModelSelectionIntent(): AgentModelSelectionIntent {
    return this.modelSelectionIntentForModel(
      this.providerStore.loadSync().selectedModelId,
    )
  }

  private modelSelectionIntentForModel(
    modelId: string,
  ): AgentModelSelectionIntent {
    const entry = this.currentModelCatalog.models.find(
      (model) => model.id === modelId,
    )
    if (!entry) {
      throw new Error(`Model ${modelId} is not in the current catalog`)
    }
    return {
      gatewayId: this.currentModelCatalog.gatewayId,
      modelId,
      contextWindow: entry.capabilities.defaultContextWindow,
      catalogRevision: this.currentModelCatalog.revision,
      contextSource: 'model-selection',
    }
  }

  private async ensureTurnModelSelection(
    payload: AgentSendMessagePayload,
    reservation: AgentModelSelectionIntentReservation,
  ): Promise<AgentSendMessagePayload> {
    const intent = await this.turnModelSelectionIntent(payload, reservation)
    const result = await this.modelSelectionCoordinator.ensureForTurn(
      intent,
      payload.threadId,
      reservation,
    )
    if (!result.ok) throw new Error(result.error)
    return {
      ...payload,
      model: result.data.modelId,
      modelSelection: {
        gatewayId: result.data.gatewayId,
        modelId: result.data.modelId,
        contextWindow: result.data.contextWindow,
        catalogRevision: result.data.catalogRevision,
        contextSource: 'model-selection',
      },
    }
  }

  private async sendMessageAfterProviderBarrier(
    payload: AgentSendMessagePayload,
    reservation: AgentModelSelectionIntentReservation,
  ): Promise<AgentSendMessageResult> {
    if (!this.codexApiKey) {
      const threadId = payload.threadId ?? 'pending'
      this.emitEvent({ type: 'error', threadId, error: EMPTY_KEY_ERROR })
      throw new Error(EMPTY_KEY_ERROR)
    }

    if (!this.store || !this.attachments) {
      throw new Error('AgentManager.sendMessage called without store/attachments')
    }

    const confirmedPayload = await this.ensureTurnModelSelection(
      payload,
      reservation,
    )

    // Lazily (re)start the backend if the bootstrap start() failed or never
    // ran. Previously a swallowed boot failure left `this.client` null, so the
    // first send threw the opaque "CodexLocalBackend.send called before start".
    // Now we retry the start here and surface the ACTUAL startup error (config
    // error / spawn failure / exit tail) to the renderer as a normal error
    // event, keeping the turn recoverable once the user fixes the cause.
    try {
      await this.ensureBackendStarted()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const threadId = payload.threadId ?? 'pending'
      const message = `Codex 后端启动失败:${detail}`
      this.emitEvent({ type: 'error', threadId, error: message })
      throw new Error(message)
    }

    const assembled = await this.assembleTurnInput(confirmedPayload, true)
    const { threadId, input, userTimelineItems, collaborationModeOwner } = assembled

    let admitted = false
    let resolveAdmission!: () => void
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const markAdmitted = (): void => {
      if (admitted) return
      admitted = true
      resolveAdmission()
    }
    void this.forwardEvents(
      threadId,
      input,
      collaborationModeOwner,
      markAdmitted,
    ).catch((error: unknown) => {
      // Never leave the shared lifecycle tail wedged if thread hydration or
      // another pre-send step fails before backend.send can be admitted.
      markAdmitted()
      this.emitEvent({
        type: 'error',
        threadId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    await admission
    // `userMessageItems` lets the renderer patch its OPTIMISTIC user message
    // (raw OS path, outside the fs allowed-roots gate) with these CANONICAL
    // items (uploads-cache paths that click through immediately). JSON
    // round-trip drops `undefined` keys and guarantees structured-cloneability.
    const cloneableItems = userTimelineItems.length > 0
      ? (JSON.parse(JSON.stringify(userTimelineItems)) as typeof userTimelineItems)
      : undefined
    return {
      threadId,
      userMessageItems: cloneableItems,
      // Persisted row id → renderer `Message.dbRowId`, so a later
      // edit-and-resend can hand the branch API a real DB row id.
      ...(assembled.userMessageRowId ? { userMessageId: assembled.userMessageRowId } : {}),
    }
  }

  /**
   * Append user input to the currently in-flight turn via Codex `turn/steer`
   * (openai/codex#10821) — the app's "插话/steering" path. The appended output
   * rides the SAME turn's event stream that the original `sendMessage`'s
   * `forwardEvents` loop is still draining, so we do NOT start a new forward
   * loop here; we only persist the user message and fire the steer RPC. A
   * missing/ended turn ("no active turn") is a benign race and automatically
   * falls back to delivering the message as a fresh turn (+ an info notice);
   * other failures surface as an `error` event so the renderer can react.
   */
  async steer(payload: AgentSendMessagePayload): Promise<AgentSendMessageResult> {
    const threadIdIn = payload.threadId
    if (!threadIdIn) {
      // Steering only applies to an existing thread with an active turn.
      return { threadId: 'pending' }
    }
    const steer = this.backend.steer?.bind(this.backend)
    if (!steer) {
      const error = '当前后端不支持运行中插话(turn/steer)。'
      this.emitEvent({ type: 'error', threadId: threadIdIn, error })
      throw new Error(error)
    }
    const reservation = this.modelSelectionCoordinator.reserveIntentSequence(
      'turn',
    )
    return this.enqueueTurnAdmission(
      () => this.steerAfterProviderBarrier(
        payload,
        threadIdIn,
        steer,
        reservation,
      ),
    )
  }

  private async steerAfterProviderBarrier(
    payload: AgentSendMessagePayload,
    threadIdIn: string,
    steer: NonNullable<IAgentBackend['steer']>,
    reservation: AgentModelSelectionIntentReservation,
  ): Promise<AgentSendMessageResult> {
    if (!this.codexApiKey) {
      this.emitEvent({ type: 'error', threadId: threadIdIn, error: EMPTY_KEY_ERROR })
      throw new Error(EMPTY_KEY_ERROR)
    }
    if (!this.store || !this.attachments) {
      throw new Error('AgentManager.steer called without store/attachments')
    }
    const confirmedPayload = await this.ensureTurnModelSelection(
      payload,
      reservation,
    )
    try {
      await this.ensureBackendStarted()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const message = `Codex 后端启动失败:${detail}`
      this.emitEvent({ type: 'error', threadId: threadIdIn, error: message })
      throw new Error(message)
    }

    const assembled = await this.assembleTurnInput(confirmedPayload, true)
    const { threadId, input, userTimelineItems, collaborationModeOwner } = assembled
    const codexThreadId = this.codexThreadIdByDbThreadId.get(threadId) ?? threadId
    try {
      await steer(codexThreadId, input)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (isNoActiveTurnSteerError(detail)) {
        // Lost the inherent turn/steer race: the turn completed between the
        // user's keypress and the RPC (steering targets the CURRENT turn by
        // design — openai/codex#10821). The message is already assembled and
        // persisted, so deliver it as a FRESH turn instead of dumping a raw
        // protocol error on the user and making them retype/resend.
        this.emitEvent({
          type: 'notice',
          notice: {
            id: `steer-fallback:${Date.now()}`,
            kind: 'steerFallback',
            level: 'info',
            threadId,
            message: '上一回合刚好已结束,插话已作为新一轮消息发送。',
          },
        })
        let admitted = false
        let resolveAdmission!: () => void
        const admission = new Promise<void>((resolve) => {
          resolveAdmission = resolve
        })
        const markAdmitted = (): void => {
          if (admitted) return
          admitted = true
          resolveAdmission()
        }
        void this.forwardEvents(
          threadId,
          input,
          collaborationModeOwner,
          markAdmitted,
        ).catch((err: unknown) => {
          markAdmitted()
          this.emitEvent({
            type: 'error',
            threadId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
        // The fresh turn must register backend.send as in-flight before steer
        // releases its lifecycle slot. Otherwise a Provider replacement can
        // splice itself between the no-active response and fallback send.
        await admission
      } else {
        // Genuine failure (transport down, backend crash…): the persisted user
        // message stays (it IS part of the conversation); the renderer surfaces
        // the error and the user can resend it as a fresh turn.
        this.emitEvent({ type: 'error', threadId, error: detail })
      }
    }
    const cloneableItems = userTimelineItems.length > 0
      ? (JSON.parse(JSON.stringify(userTimelineItems)) as typeof userTimelineItems)
      : undefined
    return {
      threadId,
      userMessageItems: cloneableItems,
      ...(assembled.userMessageRowId ? { userMessageId: assembled.userMessageRowId } : {}),
    }
  }

  /**
   * Assemble a turn's `AgentInput` from a renderer payload: ingest attachments,
   * build the prompt (attachment/reference mentions), resolve skill items, and
   * persist the user message row. Shared by `sendMessage` (starts a new turn)
   * and `steer` (appends to the in-flight turn). Callers guarantee the backend
   * is started and the API key is present.
   */
  private async assembleTurnInput(
    payload: AgentSendMessagePayload,
    providerAdmissionHeld = false,
  ): Promise<{
    threadId: string
    model: string
    input: AgentInput
    userTimelineItems: TimelineItem[]
    /** Persisted AgentMessage row id of this turn's user message (= clientUserMessageId). */
    userMessageRowId?: string
    collaborationModeOwner?: CollaborationCapabilityOwner
  }> {
    if (!this.store || !this.attachments) {
      throw new Error('AgentManager.assembleTurnInput called without store/attachments')
    }
    const model = payload.model?.trim() || DEFAULT_AGENT_MODEL
    let builtCollaborationMode: BuiltCollaborationMode | undefined
    try {
      builtCollaborationMode = payload.collaborationModeKind === undefined
        ? undefined
        : await (
            providerAdmissionHeld
              ? this.buildCollaborationModeWithProviderAdmissionHeld(
                  payload.collaborationModeKind,
                  model,
                  payload.reasoningEffort,
                  payload.planReasoningEffort ?? 'auto',
                )
              : this.buildCollaborationMode(
                  payload.collaborationModeKind,
                  model,
                  payload.reasoningEffort,
                  payload.planReasoningEffort ?? 'auto',
                )
          )
    } catch (error) {
      this.emitEvent({
        type: 'error',
        threadId: payload.threadId ?? 'pending',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error instanceof Error ? error : new Error(String(error))
    }
    // The uploads cache is a first-class reference root: AttachmentService
    // canonicalizes every attachment into `<userData>/agent/uploads/<sha>.<ext>`
    // and the fs IPC gate (fsIpc.resolveAllowedRoots) has always whitelisted
    // it so chips are clickable. Mirror that here, otherwise referencing an
    // uploaded file (drag from the ATTACHMENTS tree, edit-and-resend) previews
    // fine and then dies at send with "Reference path is outside allowed roots".
    const referenceMapping = await mapReferencesToInputItems(payload.references, [
      ...this.allowedRoots,
      path.join(this.userDataDir, 'agent', 'uploads'),
    ])
    // Plan B routing for the upcoming `thread/start`: when the confirmed
    // selection routes to a Channel other than the process-active one (a
    // same-gateway sibling registered as an extra provider table), the new
    // codex thread must carry `modelProvider` + a thread-scoped context pin —
    // otherwise it would silently start on the wrong provider.
    const selection = payload.modelSelection
    const selectionRoute = selection
      ? resolveGatewayModelRoute(
          selection.gatewayId,
          selection.modelId,
          this.providerStore.loadSync().customProviders,
        )
      : undefined
    const routesOffActiveChannel = selectionRoute !== undefined
      && selectionRoute.channelId !== this.channelController.currentChannelId()
    const thread = payload.threadId
      ? { id: payload.threadId }
      : await this.store.createThread({
          title: payload.content.slice(0, 40) || 'New Agent Thread',
          model,
        })
    if (!payload.threadId && selection && selectionRoute) {
      // Bind the fresh conversation to its Channel immediately, so a later
      // GLOBAL switch can never re-route it (and switching THIS thread back
      // is recognized as a no-op by the coordinator).
      await this.store.setThreadRouting?.(thread.id, {
        model: selection.modelId,
        gatewayId: selection.gatewayId,
        modelProvider: selectionRoute.channelId,
      }).catch(() => undefined)
    }
    if (referenceMapping.skippedReferences.length > 0) {
      this.emitEvent({
        type: 'notice',
        notice: {
          id: `stale-reference:${thread.id}:${Date.now()}`,
          kind: 'attachmentSkipped',
          level: 'warning',
          threadId: thread.id,
          message: `已跳过 ${referenceMapping.skippedReferences.length} 个失效附件引用:${referenceMapping.skippedReferences.join('、')}`,
        },
      })
    }
    const attachmentInputs = payload.attachments ?? []
    // Per-attachment failures are non-fatal: AttachmentService emits an
    // 'attachment-error' event for each skipped file, we relay it to the
    // renderer as a notice, and the rest of the turn proceeds with whichever
    // files *did* succeed. This matches the recovery direction Codex itself
    // is shipping for openai/codex#13508 — "remove failed attachment, keep
    // the turn alive".
    const onAttachmentError = (e: { name: string; error: string }): void => {
      this.emitEvent({ type: 'attachment_error', threadId: thread.id, name: e.name, error: e.error })
    }
    // The injected attachments service is typed as `AttachmentService`-like
    // in tests (just `{ ingest }`), so guard the EventEmitter wiring.
    const emitterLike = this.attachments as Partial<{
      on(event: string, fn: (e: { name: string; error: string }) => void): void
      off(event: string, fn: (e: { name: string; error: string }) => void): void
    }>
    const hasEmitter = typeof emitterLike.on === 'function' && typeof emitterLike.off === 'function'
    if (hasEmitter) emitterLike.on!('attachment-error', onAttachmentError)
    let savedAttachments: Awaited<ReturnType<typeof this.attachments.ingest>>
    try {
      savedAttachments = await this.attachments.ingest(thread.id, attachmentInputs)
    } finally {
      if (hasEmitter) emitterLike.off!('attachment-error', onAttachmentError)
    }
    // Anchor every attachment's on-disk localPath into the agent's text
    // prompt. The renderer file-picker only gives us a buffer — without
    // this preamble the model can't `cat`/`read_file`/etc. the attachment
    // because it has no path to anchor to. Image bytes ALSO travel via
    // `localImage` for vision models, but listing the path here is what
    // lets the agent's filesystem tools touch the same file. See
    // AgentManager.test.ts > "injects the localPath of every attachment".
    const promptText = buildPromptWithReferenceMentions(
      buildPromptWithAttachments(payload.content, savedAttachments),
      referenceMapping.textMentions,
    )
    const referenceItems = mapDuplicateAttachmentReferencesToUploadedPaths(
      referenceMapping.items,
      attachmentInputs,
      savedAttachments,
    )
    const localImagePaths = new Set(
      referenceItems
        .filter((item): item is Extract<typeof item, { type: 'localImage' }> => item.type === 'localImage')
        .map((item) => path.resolve(item.path)),
    )
    const localAudioPaths = new Set(
      referenceItems
        .filter((item): item is Extract<typeof item, { type: 'localAudio' }> => item.type === 'localAudio')
        .map((item) => path.resolve(item.path)),
    )
    const skillItems: AgentInput['items'] = (payload.skills ?? [])
      // Defensive dedupe — if the renderer detected `$foo $foo` we still want
      // a single `skill` input item, otherwise codex injects the SKILL.md
      // instructions twice and burns tokens.
      .filter((skill, idx, arr) => arr.findIndex((s) => s.name === skill.name) === idx)
      .map((skill) => ({ type: 'skill' as const, name: skill.name, path: skill.path }))
    // Plugin/app `mention` items (codex app-server "Invoke a plugin"): dedupe
    // by path — the path IS the identity (`plugin://<name>@<marketplace>`),
    // and a doubled `@foo @foo` must not activate the plugin twice.
    const mentionItems: AgentInput['items'] = (payload.mentions ?? [])
      .filter((mention, idx, arr) => arr.findIndex((m) => m.path === mention.path) === idx)
      .map((mention) => ({ type: 'mention' as const, name: mention.name, path: mention.path }))
    const items: AgentInput['items'] = [
      { type: 'text', text: promptText },
      ...skillItems,
      ...mentionItems,
      ...referenceItems,
      ...savedAttachments
        .filter((item) => item.mime.startsWith('image/'))
        .filter((item) => {
          const resolved = path.resolve(item.localPath)
          if (localImagePaths.has(resolved)) return false
          localImagePaths.add(resolved)
          return true
        })
        .map((item) => ({ type: 'localImage' as const, path: item.localPath })),
      // Codex 0.145 audio inputs: attached audio files travel as native
      // `localAudio` items (codex reads the file and builds the data URI at
      // serialization time) instead of degrading to a path-text mention.
      // Extension fallback covers sources that stat audio files as
      // application/octet-stream; .webm/.mp4 need an explicit audio/* mime.
      ...savedAttachments
        .filter((item) =>
          item.mime.startsWith('audio/') ||
          AUDIO_EXTENSIONS.has(path.extname(item.localPath).toLowerCase()))
        .filter((item) => {
          const resolved = path.resolve(item.localPath)
          if (localAudioPaths.has(resolved)) return false
          localAudioPaths.add(resolved)
          return true
        })
        .map((item) => ({ type: 'localAudio' as const, path: item.localPath })),
    ]

    // Persist the user turn before kicking off the backend so that:
    //   1) After an app restart `switchThread` actually has chat history to load
    //      (regression: AgentMessage rows were never written before this change).
    //   2) `ThreadTitleSummarizer.maybeSummarize` can read both a user and an
    //      assistant message later — its gate `messages.length < 2` was the
    //      reason auto-titles never appeared in the thread switcher.
    const userTimelineItems = this.buildUserTimelineItems(payload.content, savedAttachments)
    let clientUserMessageId: string | undefined
    if (userTimelineItems.length > 0) {
      // Same JSON round-trip as the assistant path: TimelineItem is a tagged
      // union and Prisma's InputJsonValue rejects it at compile time even
      // though the runtime shape is pure JSON.
      const userJsonItems = JSON.parse(JSON.stringify(userTimelineItems)) as Parameters<
        ThreadStore['addMessage']
      >[0]['items']
      try {
        const savedMessage = await this.store.addMessage({ threadId: thread.id, role: 'user', items: userJsonItems })
        // Official-compat: forward our persisted row id as the app-server v2
        // `clientUserMessageId` — the rollout's `userMessage` item echoes it as
        // `clientId`, so codex-native history (thread/read, fork, resume) maps
        // 1:1 to our DB rows without content heuristics.
        clientUserMessageId = savedMessage?.id
        // best-effort: failing to bump lastMessageAt should not block the turn
        await this.store.updateLastMessageAt(thread.id).catch(() => undefined)
      } catch (err) {
        // This row is BOOKKEEPING, not a precondition of the turn. When the
        // local DB wedges — PGlite dropping its socket surfaces as Prisma
        // `P1017 Server has closed the connection` — a bare await here rejected
        // the whole IPC call, so the user's message never reached the model and
        // they got a packed Prisma stack with no way out but restarting the app.
        //
        // Everything else on this path already refuses to hold the message
        // hostage: stale references are skipped with a notice, per-attachment
        // ingest failures are isolated, `setThreadRouting` and
        // `updateLastMessageAt` are both `.catch`ed. This line was the one
        // holdout. Degrade the same way — announce the loss, keep the turn.
        const detail = err instanceof Error ? err.message : String(err)
        console.warn(`[AgentManager] user turn not persisted (turn continues): ${detail}`)
        this.emitEvent({
          type: 'notice',
          notice: {
            id: `history-persist:${thread.id}:${Date.now()}`,
            kind: 'historyPersistDegraded',
            level: 'warning',
            threadId: thread.id,
            message: '本地数据库暂时不可用,这条消息已发给模型但没能写入历史'
              + '(重启后不会出现在会话记录里,也无法基于它编辑重发)。',
            details: { reason: detail },
          },
        })
      }
    }

    const input: AgentInput = {
      ...payload,
      model,
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      clientUserMessageId,
      items,
    }

    // Only consumed by `thread/start` (turns on existing codex threads ignore
    // it): pin the thread to the sibling Channel + its context window when it
    // routes off the process-active provider. Spread-omit otherwise so the
    // legacy wire shape stays byte-identical.
    if (routesOffActiveChannel && selection && selectionRoute) {
      input.modelProvider = selectionRoute.channelId
      input.threadContextPin = resolveModelContextPin(
        selection.modelId,
        selection.contextWindow,
      )
    }

    // Expand the composer's preset KIND into the full experimental codex
    // `CollaborationMode` (turn/start only — upstream turn/steer has no such
    // field). Explicit Plan and Default are both persistent mode selections,
    // so both get a complete wire object. Only a genuinely absent KIND keeps
    // legacy callers byte-compatible by omitting the field.
    if (builtCollaborationMode !== undefined) {
      input.collaborationMode = builtCollaborationMode.collaborationMode
    }

    return {
      threadId: thread.id,
      model,
      input,
      userTimelineItems,
      ...(clientUserMessageId ? { userMessageRowId: clientUserMessageId } : {}),
      collaborationModeOwner: builtCollaborationMode?.owner,
    }
  }

  /**
   * Reasoning effort for Plan-mode turns, sourced from the official
   * `collaborationMode/list` Plan preset mask (see {@link collabModePresets}).
   * Never throws — the preset lookup is best-effort polish, not a gate on
   * sending the turn.
   */
  private async loadCollaborationModePresets(): Promise<CodexCollaborationModeMask[]> {
    this.syncCollaborationProcessCaches()
    if (this.collabModePresets) return this.collabModePresets
    if (typeof this.backend.listCollaborationModes !== 'function') {
      throw new Error('Codex collaboration mode list API is unavailable')
    }
    const response = await this.backend.listCollaborationModes()
    this.collabModePresets = response.data
    return this.collabModePresets
  }

  private async planPresetReasoningEffort(): Promise<string | null> {
    try {
      const presets = await this.loadCollaborationModePresets()
      return presets.find((mask) => mask.mode === 'plan')?.reasoning_effort ?? null
    } catch {
      return null
    }
  }

  private async buildCollaborationMode(
    mode: CollaborationModeKind,
    model: string,
    defaultEffort: string | undefined,
    planPreference: PlanReasoningEffort,
  ): Promise<BuiltCollaborationMode> {
    return this.buildCollaborationModeUsingResolver(
      mode,
      model,
      defaultEffort,
      planPreference,
      (modelId, includePlanPreset) =>
        this.resolveCollaborationCapabilities(modelId, includePlanPreset),
    )
  }

  /**
   * PRECONDITION: called only while sendMessage owns turn admission.
   */
  private async buildCollaborationModeWithProviderAdmissionHeld(
    mode: CollaborationModeKind,
    model: string,
    defaultEffort: string | undefined,
    planPreference: PlanReasoningEffort,
  ): Promise<BuiltCollaborationMode> {
    return this.buildCollaborationModeUsingResolver(
      mode,
      model,
      defaultEffort,
      planPreference,
      (modelId, includePlanPreset) =>
        this.resolveCollaborationCapabilitiesWithProviderAdmissionHeld(
          modelId,
          includePlanPreset,
        ),
    )
  }

  private async buildCollaborationModeUsingResolver(
    mode: CollaborationModeKind,
    model: string,
    defaultEffort: string | undefined,
    planPreference: PlanReasoningEffort,
    resolveCapabilities: (
      modelId: string,
      includePlanPreset: boolean,
    ) => Promise<ResolvedCollaborationCapabilities>,
  ): Promise<BuiltCollaborationMode> {
    if (mode === 'default') {
      return {
        collaborationMode: {
          mode,
          settings: {
            model,
            reasoning_effort: defaultEffort ?? null,
            developer_instructions: null,
          },
        },
      }
    }

    const resolved = await resolveCapabilities(
      model,
      planPreference === 'auto',
    )
    const supportedPlanEfforts = resolved.capabilities.supportedPlanEfforts
    if (
      planPreference !== 'auto'
      && !supportedPlanEfforts.includes(planPreference)
    ) {
      throw new Error(
        `Plan reasoning effort "${planPreference}" is not supported for `
        + `${resolved.model} on Provider "${resolved.capabilities.providerId}"`,
      )
    }
    const reasoningEffort =
      planPreference === 'auto'
        ? resolved.capabilities.planDefaultEffort
        : planPreference

    return {
      collaborationMode: {
        mode,
        settings: {
          model,
          reasoning_effort: reasoningEffort,
          developer_instructions: null,
        },
      },
      owner: {
        providerId: resolved.capabilities.providerId,
        backendEpoch: resolved.capabilities.backendEpoch,
      },
    }
  }

  private isCollaborationCapabilityOwnerCurrent(
    owner: CollaborationCapabilityOwner,
  ): boolean {
    return (
      this.channelController.currentChannelId() === owner.providerId
      && this.backend.currentEpoch?.() === owner.backendEpoch
    )
  }

  private commitWithCollaborationModeOwner<T>(
    built: BuiltCollaborationMode,
    submit: () => T,
  ): T {
    if (
      built.owner !== undefined
      && !this.isCollaborationCapabilityOwnerCurrent(built.owner)
    ) {
      throw new Error(
        'Plan capability owner changed at commit boundary; please retry',
      )
    }
    return submit()
  }

  private async stabilizeCollaborationMode(
    built: BuiltCollaborationMode,
    mode: CollaborationModeKind,
    model: string,
    defaultEffort: string | undefined,
    planPreference: PlanReasoningEffort,
  ): Promise<BuiltCollaborationMode> {
    return this.stabilizeCollaborationModeUsingRebuild(
      built,
      mode,
      () => this.buildCollaborationMode(
        mode,
        model,
        defaultEffort,
        planPreference,
      ),
    )
  }

  /**
   * PRECONDITION: called only while sendMessage owns turn admission.
   */
  private async stabilizeCollaborationModeWithProviderAdmissionHeld(
    built: BuiltCollaborationMode,
    mode: CollaborationModeKind,
    model: string,
    defaultEffort: string | undefined,
    planPreference: PlanReasoningEffort,
  ): Promise<BuiltCollaborationMode> {
    return this.stabilizeCollaborationModeUsingRebuild(
      built,
      mode,
      () => this.buildCollaborationModeWithProviderAdmissionHeld(
        mode,
        model,
        defaultEffort,
        planPreference,
      ),
    )
  }

  private async stabilizeCollaborationModeUsingRebuild(
    built: BuiltCollaborationMode,
    mode: CollaborationModeKind,
    rebuild: () => Promise<BuiltCollaborationMode>,
  ): Promise<BuiltCollaborationMode> {
    if (
      mode === 'default'
      || (
        built.owner !== undefined
        && this.isCollaborationCapabilityOwnerCurrent(built.owner)
      )
    ) {
      return built
    }

    const rebuilt = await rebuild()
    if (
      rebuilt.owner !== undefined
      && !this.isCollaborationCapabilityOwnerCurrent(rebuilt.owner)
    ) {
      throw new Error(
        'Plan capability owner changed repeatedly before backend submission; please retry',
      )
    }
    return rebuilt
  }

  private buildUserTimelineItems(
    content: string,
    savedAttachments: ReadonlyArray<{
      id: string
      originalName: string
      localPath: string
      mime: string
      size: number
    }>,
  ): TimelineItem[] {
    const now = Date.now()
    const out: TimelineItem[] = []
    const text = content.trim()
    if (text.length > 0) {
      out.push({ type: 'text', id: createTimelineId(), startedAt: now, content: text })
    }
    if (savedAttachments.length > 0) {
      const refs: AttachmentRef[] = savedAttachments.map((a) => ({
        id: a.id ?? createTimelineId(),
        kind: a.mime.startsWith('image/')
          ? 'image'
          : a.mime.startsWith('video/')
            ? 'video'
            : a.mime.startsWith('audio/')
              ? 'audio'
              : 'file',
        name: a.originalName,
        mime: a.mime,
        size: a.size,
        uri: 'local-file:///' + a.localPath.replace(/\\/g, '/'),
      }))
      out.push({ type: 'attachment', id: createTimelineId(), startedAt: now, attachments: refs })
    }
    return out
  }

  async cancel(threadId: string): Promise<void> {
    const codexThreadId = this.codexThreadIdByDbThreadId.get(threadId)
    await this.backend.cancel(codexThreadId ?? threadId)
    await this.interruptSubagentsOf(threadId)
  }

  /**
   * Stops this conversation's still-running sub-agents.
   *
   * Upstream does not cascade: `interrupt_agent` acts on a single thread, and
   * unlike `close_agent` — whose tool description says "and any open
   * descendants" — it has no descendant walk. So without this, pressing stop
   * ended the parent turn while every child kept generating paid work the user
   * had explicitly cancelled.
   *
   * Best-effort and never rethrows: a failed interrupt must not turn the user's
   * cancel into an error, and the parent turn is already stopped by then.
   */
  private async interruptSubagentsOf(dbThreadId: string): Promise<void> {
    const interrupt = this.backend.interruptTurn
    if (!interrupt) return
    const live = [...this.subagentTurnByThread].filter(
      ([childThreadId]) => this.subagentParentByCodexThread.get(childThreadId) === dbThreadId,
    )
    await Promise.all(live.map(async ([childThreadId, turnId]) => {
      this.subagentTurnByThread.delete(childThreadId)
      try {
        await interrupt.call(this.backend, childThreadId, turnId)
      } catch (err) {
        console.warn(`[AgentManager] interrupting sub-agent ${childThreadId} failed:`, err)
      }
    }))
  }

  /**
   * Reverse-map a Codex thread UUID (from an MCP tool call's `_meta`) to our DB
   * thread id. Used by the MCP ToolRouter so renderer tools (e.g.
   * `generate_image`) can attribute their UI to the chat that requested them.
   * Returns `undefined` when the mapping isn't known yet.
   */
  resolveDbThreadId(codexThreadId: string): string | undefined {
    return findDbThreadId(this.codexThreadIdByDbThreadId, codexThreadId)
      ?? this.subagentParentByCodexThread.get(codexThreadId)
  }

  async respondToApprovalResponse(response: CodexApprovalResponse): Promise<{ ok: boolean; error?: string }> {
    if (!this.backend.respondToApprovalResponse) {
      return { ok: false, error: 'Codex approval response API is unavailable' }
    }
    try {
      await this.backend.respondToApprovalResponse(response)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async listThreads() {
    if (!this.store) throw new Error('AgentManager.listThreads called without store')
    return this.store.listThreads()
  }

  async listCodexThreads(params?: ListThreadsParams): Promise<CodexThreadSummary[]> {
    if (!this.backend.isHealthy() || !this.backend.listThreads) return []
    try {
      return await this.backend.listThreads(params)
    } catch (err) {
      console.warn('[AgentManager] failed to list Codex threads:', err)
      return []
    }
  }

  async readCodexThread(threadId: string): Promise<CodexThreadDetail> {
    const id = validateCodexThreadId(threadId)
    if (!this.backend.isHealthy()) throw new Error('Codex backend is not healthy')
    if (!this.backend.readThread) throw new Error('Codex thread read API is unavailable')
    return this.backend.readThread(id)
  }

  async forkCodexThread(threadId: string): Promise<CodexThreadSummary> {
    const id = validateCodexThreadId(threadId)
    if (!this.backend.isHealthy()) throw new Error('Codex backend is not healthy')
    if (!this.backend.forkThread) throw new Error('Codex thread fork API is unavailable')
    return this.backend.forkThread(id)
  }

  /**
   * Edit-and-resend server-side context branch (codex 0.145 `thread/fork` +
   * `lastTurnId`; upstream TUI semantics from openai/codex PR #33201):
   * fork the codex thread THROUGH the turn of the last user message BEFORE
   * the edited row, so the branch's server context exactly matches the
   * renderer's truncated timeline; the original thread stays untouched on
   * disk. Editing the first prompt (or a thread with no codex mapping)
   * degrades gracefully to fresh-thread semantics, and EVERY failure path
   * returns a `branched: false` marker instead of throwing — the renderer
   * then falls back to today's same-thread resend.
   *
   * `thread/rollback` is deliberately NOT used: it is marked DEPRECATED
   * ("will be removed soon") in the 0.145 schema.
   *
   * In every path where the edit point is located in the DB, rows at/after
   * it are deleted so a thread reload can never resurrect the truncated tail
   * (DB follows the UI's edit semantics).
   */
  async branchThreadBeforeMessage(
    dbThreadId: string,
    messageRowId: string,
  ): Promise<AgentThreadBranchResult> {
    const degrade = (reason: string): AgentThreadBranchResult => {
      this.emitEvent({
        type: 'notice',
        notice: {
          id: `edit-branch-degraded:${dbThreadId}:${Date.now()}`,
          kind: 'editBranchDegraded',
          level: 'warning',
          threadId: dbThreadId,
          message: '本次编辑未能分支服务端上下文,已在原会话上重发——模型可能仍记得被删除的旧内容。',
          details: { reason },
        },
      })
      return { branched: false, reason }
    }
    const store = this.store
    if (
      !store
      || typeof store.listMessagesForBranch !== 'function'
      || typeof store.deleteMessages !== 'function'
    ) {
      return degrade('store-unsupported')
    }
    let rows: Awaited<ReturnType<ThreadStore['listMessagesForBranch']>>
    try {
      rows = await store.listMessagesForBranch(dbThreadId)
    } catch (error) {
      return degrade(
        `store-read-failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const editIdx = rows.findIndex((row) => row.id === messageRowId)
    if (editIdx === -1) {
      // Renderer-local bubble id (pre-`dbRowId` sessions) or an already-gone
      // row: we can't even locate the truncation point, so leave BOTH the
      // server context and the DB untouched — pure legacy behaviour.
      return degrade('message-not-found')
    }
    const idsFromEditPoint = rows.slice(editIdx).map((row) => row.id)
    const truncateDb = async (): Promise<void> => {
      try {
        await store.deleteMessages(dbThreadId, idsFromEditPoint)
      } catch (error) {
        console.warn(
          '[AgentManager] edit-branch DB truncation failed (rows may resurrect on reload):',
          error,
        )
      }
    }

    // Branch point = the codex turn of the LAST KEPT user message (the one
    // immediately before the edit). `thread/fork` keeps turns THROUGH
    // `lastTurnId` inclusive, which drops the edited turn and everything
    // after it. Only the nearest prior user row counts: forking through an
    // OLDER turn would silently drop turns the UI still shows.
    let lastTurnId: string | undefined
    let hasPriorUserRow = false
    for (let i = editIdx - 1; i >= 0; i -= 1) {
      const row = rows[i]
      if (row.role !== 'user') continue
      hasPriorUserRow = true
      const items = Array.isArray(row.items) ? (row.items as unknown[]) : []
      const first = items[0]
      const reconcile = first && typeof first === 'object'
        ? (first as { codexReconcile?: { turnId?: unknown } }).codexReconcile
        : undefined
      const turnId = reconcile?.turnId
      if (typeof turnId === 'string' && turnId.length > 0) lastTurnId = turnId
      break
    }

    if (!hasPriorUserRow) {
      // Editing the very first prompt = upstream's "open a brand-new
      // session": drop the codex mapping so the next send runs a fresh
      // thread/start; the abandoned source thread stays archived on disk.
      this.forgetCodexThread(dbThreadId)
      await truncateDb()
      return { branched: true, mode: 'fresh' }
    }

    let codexThreadId = this.codexThreadIdByDbThreadId.get(dbThreadId)
    if (!codexThreadId && typeof store.getCodexThreadId === 'function') {
      try {
        codexThreadId = (await store.getCodexThreadId(dbThreadId)) ?? undefined
      } catch {
        codexThreadId = undefined
      }
    }
    if (!codexThreadId) {
      // No codex thread = no server-side context exists at all; the next
      // send starts fresh anyway, so UI and (empty) server already agree.
      await truncateDb()
      return { branched: true, mode: 'fresh' }
    }
    if (!lastTurnId) {
      // Legacy rows written before reconcile.turnId existed (or a gateway
      // stripped the turn scope) — we can't compute a safe branch point.
      await truncateDb()
      return degrade('no-turn-mapping')
    }
    if (!this.backend.forkThread) {
      await truncateDb()
      return degrade('fork-unsupported')
    }
    let forked: CodexThreadSummary
    try {
      // Same-provider fork: reuse the thread's own Plan B routing overrides
      // so the branch doesn't silently migrate to the process-active Channel.
      const overrides = await this.threadRoutingResumeOverrides(dbThreadId)
      forked = await this.backend.forkThread(codexThreadId, overrides, lastTurnId)
    } catch (error) {
      await truncateDb()
      return degrade(error instanceof Error ? error.message : String(error))
    }
    // Mirror rebindThreadInProcess: release the abandoned source thread so
    // codex can unload it after its idle window, then re-point the
    // conversation (map + epoch tag + persistence) at the branch.
    void Promise.resolve(this.backend.unsubscribeThread?.(codexThreadId))
      .catch((err: unknown) => {
        console.warn('[AgentManager] thread/unsubscribe after edit-branch fork failed:', err)
      })
    this.rememberCodexThread(dbThreadId, forked.id)
    await truncateDb()
    return { branched: true, mode: 'fork' }
  }

  async archiveCodexThread(threadId: string): Promise<void> {
    const id = validateCodexThreadId(threadId)
    if (!this.backend.isHealthy()) throw new Error('Codex backend is not healthy')
    if (!this.backend.archiveThread) throw new Error('Codex thread archive API is unavailable')
    return this.backend.archiveThread(id)
  }

  async unarchiveCodexThread(threadId: string): Promise<CodexThreadSummary> {
    const id = validateCodexThreadId(threadId)
    if (!this.backend.isHealthy()) throw new Error('Codex backend is not healthy')
    if (!this.backend.unarchiveThread) throw new Error('Codex thread unarchive API is unavailable')
    return this.backend.unarchiveThread(id)
  }

  /**
   * Run `codex doctor --json` (install diagnostics). Unlike the thread RPCs this
   * does NOT gate on `isHealthy()` — doctor's whole point is to explain *why* the
   * backend may be unhealthy, so it must run even when the app-server is down.
   */
  async runDoctor(): Promise<DoctorReport> {
    if (!this.backend.runDoctor) throw new Error('Codex doctor API is unavailable')
    return this.backend.runDoctor()
  }

  async loadThread(threadId: string) {
    if (!this.store) throw new Error('AgentManager.loadThread called without store')
    return this.store.loadThread(threadId)
  }

  async openThread(threadId: string) {
    if (!this.store) throw new Error('AgentManager.openThread called without store')
    return this.store.openThread(threadId)
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    if (!this.store) throw new Error('AgentManager.renameThread called without store')
    return this.store.renameThread(threadId, title)
  }

  /**
   * Delete a conversation. The local row is authoritative; codex's on-disk
   * rollout is cleaned up first (while the codex id is still resolvable — the
   * persisted mapping lives on the row we're about to drop) and best-effort:
   * a `thread/delete` failure must never wedge the user's delete button.
   *
   * Skipped entirely when the backend isn't running: deleting history on a cold
   * app shouldn't spawn codex just to unlink a file. Such rollouts stay on disk
   * (bounded by codex's own retention), which is the accepted trade-off.
   */
  async deleteThread(threadId: string): Promise<void> {
    if (!this.store) throw new Error('AgentManager.deleteThread called without store')
    await this.deleteCodexRollout(threadId)
    await this.store.deleteThread(threadId)
    this.forgetCodexThread(threadId)
  }

  private async deleteCodexRollout(dbThreadId: string): Promise<void> {
    if (!this.backend.deleteThread || !this.backend.isHealthy()) return
    try {
      const codexThreadId = await this.resolveCodexThreadIdForRpc(dbThreadId)
      if (!codexThreadId) return
      await this.backend.deleteThread(codexThreadId)
    } catch (err) {
      console.warn('[AgentManager] thread/delete failed; rollout left on disk:', err)
    }
  }

  private async confirmUnsafeSessionConfigChange(patch: Partial<CodexSessionConfig>): Promise<void> {
    const unsafeChanges: string[] = []
    if (
      patch.sandboxMode === 'danger-full-access' &&
      this.sessionConfig.sandboxMode !== 'danger-full-access'
    ) {
      unsafeChanges.push('danger-full-access sandbox')
    }
    if (
      patch.approvalPolicy === 'never' &&
      this.sessionConfig.approvalPolicy !== 'never'
    ) {
      unsafeChanges.push('never approval policy')
    }
    if (patch.webSearch === 'live' && this.sessionConfig.webSearch !== 'live') {
      unsafeChanges.push('live web search')
    }
    if (unsafeChanges.length === 0) return

    const win = this.win && !this.win.isDestroyed() ? this.win : undefined
    const options = {
      type: 'warning' as const,
      buttons: ['Apply', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Confirm Codex permissions',
      message: 'Apply unsafe Codex session permissions?',
      detail: `This change enables: ${unsafeChanges.join(', ')}.`,
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    if (result.response !== 0) {
      throw new Error('session config change cancelled')
    }
  }

  private emitEvent(event: AgentStreamEvent): void {
    // Fire-and-forget: notification failures must never break event delivery.
    try {
      this.turnNotifier.handleEvent(event)
    } catch {
      // OS notification stacks can throw (unsupported platform, dead COM
      // server on Windows); the chat stream must keep flowing regardless.
    }
    if (this.eventSink) {
      this.eventSink(event)
      return
    }
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('agent:event', event)
  }

  /**
   * Raise an OS toast for a terminal turn event. Clicking it restores focus
   * to the main window. Guarded because `Notification` may be missing in
   * slim test mocks and unsupported on some platforms.
   */
  private showSystemNotification(notification: TurnNotification): void {
    if (typeof Notification !== 'function' || !Notification.isSupported()) return
    const toast = new Notification({
      title: notification.title,
      body: notification.body,
      silent: false,
    })
    toast.on('click', () => {
      const win = this.win
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    toast.show()
  }

  private emitApprovalRequest(request: CodexApprovalRequest): void {
    const win = this.win
    if (!win || win.isDestroyed()) return

    const dbThreadId = request.threadId
      ? findDbThreadId(this.codexThreadIdByDbThreadId, request.threadId)
      : undefined
    win.webContents.send('agent:approval-request', {
      ...request,
      ...(dbThreadId ? { threadId: dbThreadId } : {}),
    })
  }

  /**
   * 服务端已自行解决/清理该审批请求（turn 开始/完成/被打断都会触发）。渲染层的
   * pendingApprovals 只在切换线程/新会话/删除线程时清空，所以必须显式撤下这张卡，
   * 否则用户会一直看着一张点了也没用的死卡片。
   */
  private emitApprovalResolved(info: { id: string; threadId?: string }): void {
    const win = this.win
    if (!win || win.isDestroyed()) return

    const dbThreadId = info.threadId
      ? findDbThreadId(this.codexThreadIdByDbThreadId, info.threadId)
      : undefined
    win.webContents.send('agent:approval-resolved', {
      id: info.id,
      ...(dbThreadId ? { threadId: dbThreadId } : {}),
    })
  }

  /**
   * Emitted when a poisoned codex thread (undecryptable replayed reasoning,
   * or replayed history past the gateway's request-byte cap) is abandoned and
   * the current message re-sent on a FRESH codex thread. The chat keeps
   * working, but codex-side memory of earlier turns is gone — the user must
   * know why the agent suddenly "forgot" the conversation.
   */
  private notifyThreadContextReset(dbThreadId: string, reason: string): void {
    // Same UX as the poisoned-thread reset, but the cause differs: a respawn
    // (crash recovery / provider switch) drops the engine-side memory rather
    // than the gateway rejecting oversized history.
    const message = reason === 'codex_restarted'
      ? 'Codex 引擎刚刚重启（崩溃自愈或切换了模型/配置），上一段对话的引擎侧记忆已随旧进程释放，已自动在全新上下文中继续——本条消息正常处理，但 AI 不再记得此前的对话内容。建议把关键结论重新粘贴给它。'
      : '上一段对话上下文已超出网关限制，已自动在全新上下文中继续——本条消息正常处理，但 AI 不再记得此前的对话内容。建议切回模型官方 Context 并重试，同时把关键结论重新粘贴给它。'
    this.emitEvent({
      type: 'notice',
      notice: {
        id: `thread-context-reset-${dbThreadId}-${Date.now()}`,
        kind: 'threadContextReset',
        level: 'warning',
        threadId: dbThreadId,
        message,
        details: { reason },
      },
    })
  }

  /**
   * Record the codex-side thread id for a db thread, tagged with the backend
   * generation that minted it so `resolveCodexThreadForSend` can later detect a
   * respawn.
   */
  /**
   * An event for a codex thread we never started a turn on — in practice a
   * sub-agent the model spawned (multi-agent V2 is on by default at 0.145; see
   * `scripts/smoke-subagents.ts` for the measured shape).
   *
   * Deliberately NOT forwarded. `forwardEvents` rewrites every event's threadId
   * to the parent DB thread before it reaches the renderer, so passing a child
   * through would splice its text into the parent's message — and the store's
   * superseded-snapshot pruning would then let the two streams delete each
   * other's items. Until the delegation UI exists, dropping is the only
   * non-corrupting option.
   *
   * The warning is per thread, not per event: one child turn emits a dozen
   * events, and this log line shares a file with live streaming traces.
   */
  private handleUnroutedEvent(event: AgentStreamEvent, context?: { turnId?: string }): void {
    const threadId = 'threadId' in event ? event.threadId : undefined
    if (!threadId) return
    // A child's turn id exists nowhere else we can reach: `turn/started` for a
    // sub-agent is dropped by the router, so its own streamed items are the
    // only carrier. Remember it so a cancel can interrupt the child too.
    if (context?.turnId && this.delegationItemByChild.has(threadId)) {
      this.subagentTurnByThread.set(threadId, context.turnId)
    }
    if (event.type === 'token_usage_updated' && this.recordSubagentUsage(threadId, event.usage)) {
      return
    }
    if (
      event.type === 'item_completed'
      && event.itemType === 'text'
      && this.recordSubagentReply(threadId, event.final)
    ) {
      return
    }
    if (event.type === 'turn_completed' && this.markSubagentFinished(threadId)) return
    if (this.warnedSubagentThreads.has(threadId)) return
    this.warnedSubagentThreads.add(threadId)
    const owner = this.subagentParentByCodexThread.get(threadId)
    console.warn(
      `[AgentManager] dropping events from sub-agent thread ${threadId}`
      + (owner ? ` (spawned by ${owner})` : ' (owner unknown)')
      + ` (no delegation UI yet; first event was ${event.type})`,
    )
  }

  /**
   * Records which conversation owns the sub-agents named by a delegation item,
   * so their tool calls can be attributed (see
   * {@link subagentParentByCodexThread}).
   *
   * A delegation whose parent codex thread we never minted is ignored: without
   * a DB thread there is nothing to attribute to, and guessing would put a
   * stranger's tool output in one of our conversations.
   */
  private noteDelegatedAgents(event: AgentStreamEvent): void {
    if (event.type !== 'item_started' && event.type !== 'item_completed') return
    if (event.itemType !== 'activity') return
    const fields = event.type === 'item_started' ? event.payload : event.final
    const delegation = (fields as { delegation?: DelegationSnapshot }).delegation
    if (!delegation) return
    const parentDbThreadId = findDbThreadId(this.codexThreadIdByDbThreadId, event.threadId)
    if (!parentDbThreadId) return
    this.delegationItems.set(event.itemId, { dbThreadId: parentDbThreadId, delegation })
    for (const agent of delegation.agents) {
      this.subagentParentByCodexThread.set(agent.threadId, parentDbThreadId)
      // First card wins. Every V2 tool call gets its own item id, so a
      // `followup_task` to a running child would otherwise move that child's
      // replies and tokens onto the follow-up card and leave the card that
      // spawned it saying "working…" forever — and steering a long job with
      // follow-ups is the normal path, not an edge case.
      if (!this.delegationItemByChild.has(agent.threadId)) {
        this.delegationItemByChild.set(agent.threadId, event.itemId)
      }
      this.enrichSubagentIdentity(agent.threadId)
    }
  }

  /**
   * Asks the child's own thread record what upstream named this spawn, then
   * relabels the card.
   *
   * V2's spawn event carries only a thread id and the path of the agent
   * definition, so without this the card reads `/root/pong_agent`. The
   * nickname lives on the child thread, which is where the TUI's agent picker
   * reads it from too.
   *
   * Fire-and-forget by design — a delegation card that shows a path is a worse
   * card, not a broken turn. A failed read clears the attempt so the next
   * report of the same child retries, which covers reading a thread that the
   * spawn has only just announced.
   */
  private enrichSubagentIdentity(childThreadId: string): void {
    if (this.subagentNickname.has(childThreadId)) return
    if (this.subagentInfoRequested.has(childThreadId)) return
    const read = this.backend.readSubagentInfo?.bind(this.backend)
    if (!read) return

    this.subagentInfoRequested.add(childThreadId)
    void read(childThreadId)
      .then((info) => {
        const nickname = info?.nickname
        if (!nickname) return
        this.subagentNickname.set(childThreadId, nickname)
        this.republishDelegation(childThreadId)
      })
      .catch(() => {
        this.subagentInfoRequested.delete(childThreadId)
      })
  }

  /**
   * Merges a sub-agent's cumulative token report into the delegation card that
   * spawned it, and reports whether the event was consumed.
   *
   * Deliberately not folded into the parent's own usage: the renderer replaces
   * `tokenUsage` wholesale and derives the context-window gauge from it, so a
   * child's absolute counts would read as parent context that isn't there.
   */
  private recordSubagentUsage(childThreadId: string, usage: AgentTokenUsage): boolean {
    this.subagentUsage.set(childThreadId, {
      input: usage.inputTokens,
      output: usage.outputTokens,
    })
    return this.republishDelegation(childThreadId)
  }

  /**
   * Salvages a sub-agent's answer from its own stream.
   *
   * Multi-agent V2 leaves the parent's `agentsStates` empty (measured with
   * `scripts/smoke-subagents.ts --v2`), so without this the delegation card
   * would say a child ran and never what it said. V1 does report the answer,
   * and that copy wins — it is the summary the parent actually acted on, while
   * this one is whatever text chunk happened to arrive last.
   */
  private recordSubagentReply(childThreadId: string, final: Record<string, unknown>): boolean {
    const content = final.content
    if (typeof content !== 'string' || content.trim().length === 0) return false
    this.subagentReply.set(childThreadId, content)
    return this.republishDelegation(childThreadId)
  }

  /**
   * Marks a sub-agent finished when its own turn ends.
   *
   * Multi-agent V2 supplies no status anywhere a parent-scoped client can see
   * it: `subAgentActivity` carries only an id and a path, and V2's `wait` item
   * reports an empty `agentsStates`. Without this the agent row would pulse
   * "working…" for the life of the card on exactly the channels where V2 is
   * enabled. The child's `turn/completed` is the one terminal signal that does
   * reach us.
   */
  private markSubagentFinished(childThreadId: string): boolean {
    if (!this.delegationItemByChild.has(childThreadId)) return false
    this.subagentFinished.add(childThreadId)
    // Nothing left to interrupt, and a stale turn id would make a later cancel
    // address a turn that no longer exists.
    this.subagentTurnByThread.delete(childThreadId)
    return this.republishDelegation(childThreadId)
  }

  /**
   * Re-emits the delegation item for whichever card owns this child, folding in
   * everything learned from the child's own stream. Returns false when the
   * child belongs to no known delegation, so the caller can fall back to the
   * drop-and-warn path.
   */
  private republishDelegation(childThreadId: string): boolean {
    const itemId = this.delegationItemByChild.get(childThreadId)
    const record = itemId ? this.delegationItems.get(itemId) : undefined
    if (!itemId || !record) return false

    const delegation: DelegationSnapshot = {
      ...record.delegation,
      agents: record.delegation.agents.map((agent) => {
        const tokens = this.subagentUsage.get(agent.threadId)
        const scraped = this.subagentReply.get(agent.threadId)
        const finished = this.subagentFinished.has(agent.threadId)
        const nickname = this.subagentNickname.get(agent.threadId)
        return {
          ...agent,
          ...(tokens ? { tokens } : {}),
          // The nickname replaces V2's agent path rather than deferring to it:
          // the path is a definition file, the nickname is this spawn.
          ...(nickname ? { name: nickname } : {}),
          // Never overwrite what the parent reported — for either field. The
          // parent's own account is what it acted on; ours is inferred.
          ...(agent.message === undefined && scraped ? { message: scraped } : {}),
          ...(agent.status === undefined && finished ? { status: 'completed' } : {}),
        }
      }),
    }
    this.delegationItems.set(itemId, { ...record, delegation })
    this.emitEvent({
      type: 'item_delta',
      threadId: record.dbThreadId,
      itemId,
      itemType: 'activity',
      patch: { kind: 'mergeFields', fields: { delegation } },
    })
    return true
  }

  private rememberCodexThread(
    dbThreadId: string,
    codexThreadId: string,
    channelIdHint?: string,
  ): void {
    this.codexThreadIdByDbThreadId.set(dbThreadId, codexThreadId)
    const epoch = this.backend.currentEpoch?.()
    if (epoch !== undefined) this.codexThreadEpochByDbThreadId.set(dbThreadId, epoch)
    // Persist (best-effort, off the hot path) so a full app restart can resume
    // this exact codex thread instead of starting a fresh, amnesiac one. Same
    // fire-and-forget posture as updateLastMessageAt — a crash between mint and
    // persist just loses the resume hint (degrades to today's behaviour).
    const persist = this.store?.setCodexThreadId?.(dbThreadId, codexThreadId)
    if (persist && typeof persist.catch === 'function') {
      persist.catch((err: unknown) =>
        console.warn('[AgentManager] failed to persist codexThreadId:', err),
      )
    }
    // A brand-new codex thread starts at the codex default, so the user's
    // per-thread choice has to be re-applied here — this is the funnel for
    // first start, fork, rebind, and restart hydration alike.
    this.reassertThreadMemoryMode(dbThreadId, codexThreadId, channelIdHint)
  }

  /** Drop both the id and its epoch tag (poisoned-thread reset / stale respawn). */
  private forgetCodexThread(dbThreadId: string): void {
    this.codexThreadIdByDbThreadId.delete(dbThreadId)
    this.codexThreadEpochByDbThreadId.delete(dbThreadId)
    // A forgotten thread is dead for this process — never resurrect it via the
    // restart-hydration path (it would re-resume a just-failed/poisoned id).
    // The next fresh thread_created repopulates the map and re-persists.
    this.codexThreadHydrationAttempted.add(dbThreadId)
  }

  /**
   * Resume overrides derived from the thread's persisted Plan B binding, so a
   * respawn/app-restart `thread/resume` re-binds the conversation to ITS OWN
   * Channel instead of the process-active provider. Returns undefined for
   * unbound (legacy) threads, cross-gateway bindings, or channels not
   * registered on the live spawn — those keep the backend's active-provider
   * fallback, exactly the pre-Plan-B behaviour.
   */
  private async threadRoutingResumeOverrides(
    dbThreadId: string,
  ): Promise<CodexThreadConfigOverrides | undefined> {
    if (!this.store) return undefined
    let routing: AgentThreadRoutingSnapshot | undefined
    try {
      routing = await this.store.getThreadRoutingSnapshot?.(dbThreadId)
    } catch {
      return undefined
    }
    if (!routing?.exists || routing.model === null || routing.modelProvider === null) {
      return undefined
    }
    if (routing.gatewayId !== null && routing.gatewayId !== this.activeGatewayId) {
      return undefined
    }
    const channelId = routing.modelProvider
    const registered = channelId === this.channelController.currentChannelId()
      || (this.backend.hasRegisteredProviderChannel?.(channelId) ?? false)
    if (!registered) return undefined
    // Per-thread context: the binding doesn't persist a window, so reuse the
    // confirmed global one when this thread runs the globally-selected model,
    // else fall back to the bound model's catalog default.
    const entry = this.currentModelCatalog.models.find(
      (model) => model.id === routing.model,
    )
    const contextWindow = routing.model === this.providerStore.loadSync().selectedModelId
      ? this.runtimeSettings.confirmed.modelContextWindow
      : entry?.capabilities.defaultContextWindow
    const pin = contextWindow !== undefined
      ? resolveModelContextPin(routing.model, contextWindow)
      : null
    return {
      model: routing.model,
      modelProvider: channelId,
      ...(pin
        ? {
            config: {
              model_context_window: pin.modelContextWindow,
              model_auto_compact_token_limit: pin.modelAutoCompactTokenLimit,
            },
          }
        : {}),
    }
  }

  /**
   * Resolve the codex thread id to use for the next `send()` on a db thread,
   * healing across app-server respawns:
   *
   * - Same generation (or backend without epoch support) → reuse the id as-is.
   * - Codex was respawned since the id was minted (the old in-memory thread is
   *   gone, so a stale id would 404 on `turn/start` and wedge the conversation —
   *   the bug behind "闪退后同一对话无法连续对话"): first try `thread/resume` to
   *   reload the SAME thread's rollout from disk into the new generation,
   *   preserving context. On success, re-tag the id to the current epoch and
   *   reuse it. If resume is unavailable or fails (thread gone/archived,
   *   oversized, unsupported), forget the mapping, tell the user the context was
   *   reset, and return undefined so the caller starts a FRESH thread.
   */
  private async resolveCodexThreadForSend(dbThreadId: string): Promise<string | undefined> {
    const id = this.codexThreadIdByDbThreadId.get(dbThreadId)
    if (!id) return this.hydrateCodexThreadAfterRestart(dbThreadId)
    const current = this.backend.currentEpoch?.()
    if (current === undefined) return id
    const stored = this.codexThreadEpochByDbThreadId.get(dbThreadId)
    if (stored === undefined || stored === current) return id

    // A crash/self-heal can advance the backend epoch outside an explicit
    // Manager.restartCodex() call. Keep process-scoped capability caches
    // synchronized before this thread is resumed into the new app-server.
    this.syncCollaborationProcessCaches()

    // Stale generation: attempt to reload the persisted thread so the user keeps
    // their conversation context across the respawn.
    if (this.backend.resumeThread) {
      try {
        // Plan B: resume onto the thread's OWN bound Channel (undefined =
        // unbound → backend falls back to the process-active provider).
        const overrides = await this.threadRoutingResumeOverrides(dbThreadId)
        await (overrides
          ? this.backend.resumeThread(id, overrides)
          : this.backend.resumeThread(id))
        // Same id is now live in the current generation — re-tag and reuse it.
        this.codexThreadEpochByDbThreadId.set(dbThreadId, current)
        return id
      } catch (err) {
        console.warn('[AgentManager] thread/resume failed, starting fresh thread:', err)
      }
    }

    this.forgetCodexThread(dbThreadId)
    this.notifyThreadContextReset(dbThreadId, 'codex_restarted')
    return undefined
  }

  /**
   * First send on a db thread whose in-memory codex mapping is empty — the
   * normal state right after a FULL app restart (the whole process, and with it
   * `codexThreadIdByDbThreadId`, was torn down). The codex rollout still lives
   * on disk under the PINNED `CODEX_HOME` (see `resolveStableCodexHome`; a
   * one-time migration also folds in any legacy `codex-runtime` rollouts), so if
   * we persisted the thread id we can `thread/resume` it and keep the
   * conversation's memory — fixing
   * "重启之后对话又没有记忆了". Falls back to a fresh thread (with a user notice)
   * when there's no persisted id, the backend can't resume, or resume fails
   * (thread gone/archived, oversized, Windows path-normalization, etc. — see
   * openai/codex#21659 / #22996). Hydration is attempted at most once per thread
   * per process; after that the in-memory map is authoritative.
   */
  private async hydrateCodexThreadAfterRestart(dbThreadId: string): Promise<string | undefined> {
    if (this.codexThreadHydrationAttempted.has(dbThreadId)) return undefined
    this.codexThreadHydrationAttempted.add(dbThreadId)

    if (!this.store?.getCodexThreadId) return undefined
    let persisted: string | null = null
    try {
      persisted = await this.store.getCodexThreadId(dbThreadId)
    } catch (err) {
      console.warn('[AgentManager] failed to read persisted codexThreadId:', err)
      return undefined
    }
    // Brand-new thread (no prior codex turn persisted) → let the caller start a
    // fresh thread normally; nothing to resume and nothing was lost.
    if (!persisted) return undefined

    // We have a persisted id from a previous app process. The current
    // app-server has never heard of it (its in-memory threads are fresh), so we
    // MUST resume it from disk before reusing it — replaying it straight into
    // turn/start would 404. No resume capability → safest to start fresh.
    if (!this.backend.resumeThread) {
      this.notifyThreadContextReset(dbThreadId, 'codex_restarted')
      return undefined
    }
    try {
      // Plan B: rebind to the thread's persisted Channel across app restarts.
      const overrides = await this.threadRoutingResumeOverrides(dbThreadId)
      await (overrides
        ? this.backend.resumeThread(persisted, overrides)
        : this.backend.resumeThread(persisted))
      // Live again in this generation — adopt it (re-tags epoch + re-persists).
      this.rememberCodexThread(dbThreadId, persisted)
      return persisted
    } catch (err) {
      console.warn('[AgentManager] thread/resume after app restart failed, starting fresh:', err)
      this.notifyThreadContextReset(dbThreadId, 'codex_restarted')
      return undefined
    }
  }

  /**
   * PRECONDITION: the caller owns the Provider/turn admission lifecycle slot.
   * Resolve/hydrate the Codex thread, revalidate Plan ownership, invoke send,
   * and synchronously prime its iterator before returning. Priming publishes
   * CodexProtocolClient's in-flight state while replacement is still excluded.
   */
  private async startForwardAttemptWithProviderAdmissionHeld(
    dbThreadId: string,
    input: AgentInput,
    collaborationModeOwner?: CollaborationCapabilityOwner,
  ): Promise<{
    codexThreadId: string | undefined
    input: AgentInput
    collaborationModeOwner?: CollaborationCapabilityOwner
    eventStream: AsyncIterable<AgentStreamEvent>
  }> {
    const codexThreadId = await this.resolveCodexThreadForSend(dbThreadId)
    let currentInput = input
    let currentCollaborationModeOwner = collaborationModeOwner
    let builtForCommit: BuiltCollaborationMode | undefined
    if (
      currentInput.collaborationModeKind !== undefined
      && currentInput.collaborationMode !== undefined
    ) {
      const stable = await this.stabilizeCollaborationModeWithProviderAdmissionHeld(
        {
          collaborationMode: currentInput.collaborationMode,
          owner: currentCollaborationModeOwner,
        },
        currentInput.collaborationModeKind,
        currentInput.model,
        currentInput.reasoningEffort,
        currentInput.planReasoningEffort ?? 'auto',
      )
      currentInput = {
        ...currentInput,
        collaborationMode: stable.collaborationMode,
      }
      currentCollaborationModeOwner = stable.owner
      builtForCommit = stable
    }
    const source = builtForCommit === undefined
      ? this.backend.send(codexThreadId, currentInput)
      : this.commitWithCollaborationModeOwner(
          builtForCommit,
          () => this.backend.send(codexThreadId, currentInput),
        )
    const eventStream = primeAsyncIterable(source)
    // Async-generator bodies resume from next() on the current job in V8, but
    // yield once while retaining admission so other backend implementations
    // can publish their equivalent in-flight state.
    await Promise.resolve()
    return {
      codexThreadId,
      input: currentInput,
      collaborationModeOwner: currentCollaborationModeOwner,
      eventStream,
    }
  }

  private async forwardEvents(
    dbThreadId: string,
    input: AgentInput,
    collaborationModeOwner?: CollaborationCapabilityOwner,
    onTurnAdmitted?: () => void,
  ): Promise<void> {
    let canRetryPoisonedThread = true
    let currentInput = input
    let currentCollaborationModeOwner = collaborationModeOwner

    while (true) {
      let attempt: Awaited<ReturnType<AgentManager['startForwardAttemptWithProviderAdmissionHeld']>>
      if (onTurnAdmitted) {
        const markAdmitted = onTurnAdmitted
        try {
          // Initial send/fallback is already inside its caller's admission.
          attempt = await this.startForwardAttemptWithProviderAdmissionHeld(
            dbThreadId,
            currentInput,
            currentCollaborationModeOwner,
          )
        } catch (error) {
          markAdmitted()
          onTurnAdmitted = undefined
          throw error
        }
        markAdmitted()
        onTurnAdmitted = undefined
      } else {
        // Poisoned-thread recovery creates another backend.send after the first
        // stream has ended. Re-admit every such attempt so Provider replacement
        // cannot splice itself between the two generations.
        attempt = await this.enqueueTurnAdmission(
          () => this.startForwardAttemptWithProviderAdmissionHeld(
            dbThreadId,
            currentInput,
            currentCollaborationModeOwner,
          ),
        )
      }
      const {
        codexThreadId,
        input: admittedInput,
        collaborationModeOwner: admittedOwner,
        eventStream,
      } = attempt
      currentInput = admittedInput
      currentCollaborationModeOwner = admittedOwner
      // Accumulate the assistant turn's timeline items in main-process memory so
      // we can write a single AgentMessage row at turn_completed time. Mirrors
      // (a tiny subset of) the renderer's `applyEvent` reducer; kept inline to
      // avoid a circular renderer→main import.
      let assistantItems: TimelineItem[] = []
      // 回合一开始就异步拍基线。没跑过命令 / 赛跑输了 / 超预算都会在 finish
      // 里收敛成空数组 —— 判断集中在 observedChanges.ts,这里只负责喂依赖。
      const makeObserver = (): ObservedChangeTracker =>
        beginObservedChanges({
          roots: () => [...this.allowedRoots],
          snapshot: (roots) => takeSnapshot(roots),
          diff: diffSnapshots,
        })
      let observer: ObservedChangeTracker | null = makeObserver()
      try {
        for await (const event of eventStream) {
          // 追踪器和 assistantItems 同寿:turn_completed 处把它卸掉,这里在下一个
          // 回合的第一个事件上重新武装。常态下迭代器在 turn_completed 之后就结束,
          // 这一行不会付任何代价。
          observer ??= makeObserver()
          if (event.type === 'thread_created' && event.threadId) {
            this.rememberCodexThread(dbThreadId, event.threadId)
          }
          if (event.type === 'error' && canRetryPoisonedThread && isPoisonedThreadError(event.error)) {
            canRetryPoisonedThread = false
            this.forgetCodexThread(dbThreadId)
            if (isOversizedRequestError(event.error)) {
              this.notifyThreadContextReset(dbThreadId, 'request_too_large')
            }
            break
          }
          if (event.type === 'user_message_reconciled') {
            // Internal event: fold the rollout's canonical userMessage echo
            // onto our persisted row (located by clientId = the row id we
            // sent as clientUserMessageId) and swallow it — the renderer
            // already shows the local user bubble, so forwarding would
            // duplicate the message. Best-effort by design: no clientId, no
            // store hook, or a DB hiccup just skips the enhancement.
            const rowId = event.reconcile.clientId
            if (rowId && this.store?.attachCodexReconcile) {
              const reconcileJson = JSON.parse(JSON.stringify(event.reconcile)) as Parameters<
                ThreadStore['attachCodexReconcile']
              >[1]
              await this.store.attachCodexReconcile(rowId, reconcileJson).catch((err: unknown) => {
                console.warn('[AgentManager] userMessage reconcile persist failed (best-effort):', err)
              })
            }
            continue
          }
          if (!this.eventSink && this.win?.isDestroyed()) return
          // Read BEFORE the rewrite below: a delegation names its children by
          // codex thread id, and matching them to this conversation needs the
          // codex-side parent id the event still carries here.
          this.noteDelegatedAgents(event)
          // Renderer's chat store filters events by its DB threadId. Always rewrite
          // so codex-side UUIDs never leak into the UI layer. Out-of-band variants
          // (mcp_*, skills_changed, notice) carry no threadId — forward untouched.
          this.emitEvent('threadId' in event ? { ...event, threadId: dbThreadId } : event)

          assistantItems = applyAssistantEvent(assistantItems, event)

          if (event.type === 'item_started' && event.itemType === 'shell') {
            observer.noteShellStarted()
          }

          if (event.type === 'turn_completed') {
            // 落库之前把观察到的改动补进去,这样直播和历史看到的是同一份。
            const reportedPaths = new Set(
              assistantItems.flatMap((item) =>
                item.type === 'fileEdit' ? item.changes.map((c) => c.path) : [],
              ),
            )
            const observedChanges = await observer.finish(reportedPaths).catch(() => [] as FileChange[])
            if (observedChanges.length > 0) {
              const observedEvent: AgentStreamEvent = {
                type: 'item_completed',
                threadId: dbThreadId,
                itemId: createTimelineId(),
                itemType: 'fileEdit',
                final: {
                  changes: observedChanges,
                  totalAdded: observedChanges.reduce((s, c) => s + c.added, 0),
                  totalRemoved: observedChanges.reduce((s, c) => s + c.removed, 0),
                },
              }
              this.emitEvent(observedEvent)
              assistantItems = applyAssistantEvent(assistantItems, observedEvent)
            }

            if (this.store && assistantItems.length > 0) {
              try {
                // TimelineItem is a discriminated union; Prisma's InputJsonValue
                // doesn't accept tagged unions directly even though the runtime
                // payload is plain JSON. A round-trip through JSON.parse forces
                // the structural shape Prisma expects without losing information.
                const jsonItems = JSON.parse(JSON.stringify(assistantItems)) as Parameters<
                  ThreadStore['addMessage']
                >[0]['items']
                await this.store.addMessage({
                  threadId: dbThreadId,
                  role: 'assistant',
                  items: jsonItems,
                })
                await this.store.updateLastMessageAt(dbThreadId).catch(() => undefined)
              } catch (err) {
                console.warn('[AgentManager] failed to persist assistant message:', err)
              }
            }
            // Reset accumulator for any subsequent turns on this same generator.
            // (Practically the iterator ends after turn_completed, but keep this
            // defensive in case backend yields multi-turn streams later.)
            assistantItems = []
            // 追踪器必须跟着一起卸。finish() 是记忆化的 —— 同一条 stream 上真来了
            // 第二个回合时复用它,会把第一回合的改动原样再报一次,那是一张**错的**
            // 卡,不是白费一次 IO。置 null 而不是就地重建:重建等于每个回合末尾都
            // 白拍一份完整工作区快照,而且那份孤儿快照还会在后台一直扫下去。
            observer = null

            if (dbThreadId && !this.firstTurnDoneByThread.get(dbThreadId)) {
              this.firstTurnDoneByThread.set(dbThreadId, true)
              this.summarizer?.maybeSummarize(dbThreadId).catch((err: unknown) => {
                console.warn('[AgentManager] thread title summarization failed:', err)
              })
            }
          }
        }
        if (!canRetryPoisonedThread && !this.codexThreadIdByDbThreadId.has(dbThreadId)) {
          continue
        }
        return
      } catch (error) {
        if (codexThreadId && canRetryPoisonedThread && isPoisonedThreadError(error)) {
          canRetryPoisonedThread = false
          this.forgetCodexThread(dbThreadId)
          if (isOversizedRequestError(error)) {
            this.notifyThreadContextReset(dbThreadId, 'request_too_large')
          }
          continue
        }
        throw error
      }
    }
  }
}

/**
 * Invoke the underlying iterator's first next() immediately, then expose an
 * equivalent iterable for normal consumption. CodexProtocolClient uses that
 * synchronous invocation boundary to increment activeSends before any RPC
 * awaits, which is the precise hand-off needed by Provider lifecycle locking.
 */
function primeAsyncIterable<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]()
  const first = iterator.next()
  return {
    async *[Symbol.asyncIterator]() {
      let result = await first
      try {
        while (!result.done) {
          yield result.value
          result = await iterator.next()
        }
      } finally {
        if (!result.done) {
          await iterator.return?.()
        }
      }
    },
  }
}

function createTimelineId(): string {
  return crypto.randomUUID()
}

function findDbThreadId(map: Map<string, string>, codexThreadId: string): string | undefined {
  for (const [dbThreadId, value] of map) {
    if (value === codexThreadId) return dbThreadId
  }
  return undefined
}

function validateCodexThreadId(threadId: string): string {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new Error('Codex thread id must be a non-empty string')
  }
  return threadId
}

function isUnsupportedThreadSettingsUpdate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /method not found|unknown method|thread\/settings\/update.*(?:unsupported|requires experimentalApi)/i
    .test(message)
}

/**
 * Stateless relays replay the whole thread (incl. reasoning blocks with
 * `encrypted_content`) on every turn. When the gateway can't validate a
 * replayed block — typically because the thread earlier ran against a
 * different upstream route/model that minted blocks in another format —
 * the thread is permanently poisoned: every retry replays the same bad
 * blocks. The only cure is a FRESH codex thread (history not replayed),
 * which `forwardEvents` does when this matcher fires.
 *
 * Known wordings in the wild:
 *  - `invalid_encrypted_content` (OpenAI canonical error code)
 *  - "Encrypted content could not be decrypted"
 *  - "encrypted content missing recognized prefix (expected `rsn_` or
 *    `smry_`)" with code `validation_error` (apiyi emulation, 2026-06-11)
 */
function isInvalidEncryptedContentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('invalid_encrypted_content')
    || /encrypted content (could not be decrypted|missing recognized prefix)/i.test(message)
  )
}

/**
 * The replayed thread history exceeds the gateway's request-body byte cap
 * ("request_too_large" / HTTP 413). Every retry on the SAME codex thread
 * replays the same oversized history, so the thread is permanently wedged
 * (openai/codex#11440 — no upstream client-side fix). Typical trigger: a
 * batch of view_image calls injecting N × multi-MB base64 into history.
 */
function isOversizedRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('request_too_large')
    || /request exceeds the maximum allowed size/i.test(message)
    || /413 payload too large/i.test(message)
  )
}

/**
 * `thread/fork`/`thread/resume` rejection for a thread that has no rollout on
 * disk yet — a thread that was started but never completed a turn. There is
 * no history to preserve, so callers can safely fall back to a fresh thread.
 */
function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no rollout found/i.test(message)
}

/**
 * Errors that permanently poison a codex thread: every subsequent turn
 * replays the same bad history and fails identically. The only cure is
 * re-sending the current message on a FRESH codex thread (history not
 * replayed). `forwardEvents` does exactly that, once per send.
 */
function isPoisonedThreadError(error: unknown): boolean {
  return isInvalidEncryptedContentError(error) || isOversizedRequestError(error)
}

/**
 * `turn/steer` rejection meaning the targeted turn already finished (or never
 * existed) — CodexProtocolClient throws `turn/steer: no active turn on thread
 * <uuid>` locally, and the codex app-server rejects the RPC with an equivalent
 * "no active/in-flight turn" message when it loses the same race server-side.
 * These are benign timing races, not failures: `steer()` converts them into a
 * fresh turn instead of surfacing an error.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mapSelectionResultToContextResult(
  result: AgentModelSelectionApplyResult,
  payload: AgentModelContextApplyPayload,
): AgentModelContextApplyResult {
  if (result.ok) {
    return {
      ok: true,
      data: {
        model: result.data.modelId,
        contextWindow: result.data.contextWindow,
        autoCompactTokenLimit: result.data.autoCompactTokenLimit,
        threadRestored: result.data.threadRestored,
        requestVersion: result.data.requestVersion,
      },
    }
  }
  return {
    ok: false,
    error: result.error,
    stage: result.stage,
    previousConfig: {
      modelContextWindow: result.previous.contextWindow,
      modelAutoCompactTokenLimit: result.previous.autoCompactTokenLimit,
    },
    attemptedConfig: {
      modelContextWindow: payload.contextWindow,
      modelAutoCompactTokenLimit: Math.floor(payload.contextWindow * 0.9),
    },
    requestVersion: result.requestVersion,
    rollback: result.rollback.ok
      ? {
          ok: true,
          activeConfig: {
            modelContextWindow: result.rollback.snapshot.contextWindow,
            modelAutoCompactTokenLimit:
              result.rollback.snapshot.autoCompactTokenLimit,
          },
        }
      : {
          ok: false,
          error: result.rollback.error,
          effectiveConfig: null,
        },
  }
}

function cloneRuntimeSettings(
  settings: PersistedCodexRuntimeSettingsV1,
): PersistedCodexRuntimeSettingsV1 {
  return {
    version: 1,
    confirmed: { ...settings.confirmed },
    ...(settings.pending
      ? {
          pending: {
            target: { ...settings.pending.target },
            requestVersion: settings.pending.requestVersion,
            startedAt: settings.pending.startedAt,
          },
        }
      : {}),
  }
}

function isNoActiveTurnSteerError(message: string): boolean {
  return /no (active|in.?flight) turn/i.test(message)
}

/**
 * Reducer mirroring the renderer's `store.applyEvent` for assistant items.
 * Used by `forwardEvents` to accumulate the streamed turn into a single
 * `AgentMessage` row written on `turn_completed`.
 *
 * Only handles the assistant-side item events (item_started / item_delta /
 * item_completed) plus stream-retry errors (`error` with `willRetry: true`,
 * which drops the failed attempt's trailing text/reasoning so the retry's
 * re-stream replaces it instead of duplicating it in the persisted row).
 * Returns the original array for unrelated event types so the caller can
 * stay in a simple reassignment pattern.
 *
 * Exported for tests.
 */
export function applyAssistantEvent(
  items: TimelineItem[],
  event: AgentStreamEvent,
): TimelineItem[] {
  if (event.type === 'error') {
    return event.willRetry ? trimRetriedStreamItems(items) : items
  }
  if (event.type !== 'item_started' && event.type !== 'item_delta' && event.type !== 'item_completed') {
    return items
  }
  const idx = items.findIndex((i) => i.id === event.itemId)
  switch (event.type) {
    case 'item_started': {
      if (idx >= 0) return items
      const created = createItemFromStarted(event.itemType, event.itemId, event.payload)
      return [...items, created]
    }
    case 'item_delta': {
      let next: TimelineItem[]
      if (idx < 0) {
        const seeded = createItemFromStarted(event.itemType, event.itemId, {})
        next = [...items, applyItemPatch(seeded, event.patch)]
      } else {
        next = items.slice()
        next[idx] = applyItemPatch(next[idx], event.patch)
      }
      // Cumulative-snapshot gateways re-send the FULL text under a NEW item
      // id per chunk; collapse superseded snapshots so the persisted row holds
      // one final paragraph instead of 100+ stacked duplicates ("对话重复").
      if (event.itemType === 'text' || event.itemType === 'reasoning') {
        next = dropSupersededStreamItems(next, event.itemId)
      }
      return next
    }
    case 'item_completed': {
      let next: TimelineItem[]
      if (idx < 0) {
        const seeded = createItemFromStarted(event.itemType, event.itemId, {})
        const merged = { ...seeded, ...event.final, type: seeded.type, endedAt: Date.now() } as TimelineItem
        next = [...items, merged]
      } else {
        next = items.slice()
        const cur = next[idx]
        next[idx] = { ...cur, ...event.final, type: cur.type, endedAt: Date.now() } as TimelineItem
      }
      if (event.itemType === 'text' || event.itemType === 'reasoning') {
        next = dropSupersededStreamItems(next, event.itemId)
      }
      return next
    }
  }
}

function createItemFromStarted(
  itemType: TimelineItem['type'],
  itemId: string,
  payload: Record<string, unknown>,
): TimelineItem {
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
    case 'choiceRequest':
      // Mirrors the renderer reducer's contract: choiceRequest cards are
      // created locally via ask() and never arrive as agent-started events.
      throw new Error('choiceRequest items are created via ask(), not agent-started events')
    default: {
      const exhaustive: never = itemType
      throw new Error(`unhandled timeline item type: ${String(exhaustive)}`)
    }
  }
}

function applyItemPatch(item: TimelineItem, patch: ItemDeltaPatch): TimelineItem {
  if (patch.kind === 'appendText') {
    if (patch.field === 'content' && (item.type === 'text' || item.type === 'reasoning')) {
      return { ...item, content: item.content + patch.text }
    }
    if (item.type === 'shell' && (patch.field === 'stdout' || patch.field === 'stderr')) {
      return { ...item, [patch.field]: item[patch.field] + patch.text }
    }
    return item
  }
  return { ...item, ...patch.fields, type: item.type } as TimelineItem
}
