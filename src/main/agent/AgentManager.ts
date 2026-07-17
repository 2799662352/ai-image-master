import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, dialog, shell } from 'electron'
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
import { mapReferencesToInputItems } from './codexUserInput'
import { validateSessionConfigPatch } from './sessionConfigValidation'
import {
  resolvePlanReasoningEffort,
  type CollaborationModeKind,
  type ConcretePlanReasoningEffort,
  type PlanReasoningEffort,
} from '../../shared/collaborationMode'
import {
  CANONICAL_MODEL_SETTINGS_ROWS,
  mergeModelSettingsCapabilities,
  modelAutoCompactTokenLimit,
  modelContextOptions,
} from '../../shared/modelSettings'
import type {
  CodexCollaborationMode,
  CodexCollaborationModeMask,
} from './codexProtocol'
import {
  CodexRuntimeSettingsStore,
  type PersistedCodexRuntimeSettingsV1,
} from './CodexRuntimeSettingsStore'
import type { BrowserWindow } from 'electron'
import type {
  AgentCollaborationCapabilities,
  AgentCollaborationCapabilitiesResult,
  AgentCollaborationModeUpdatePayload,
  AgentCollaborationModeUpdateResult,
  AgentModelContextApplyPayload,
  AgentModelContextApplyResult,
  AgentModelContextApplyStage,
  AgentModelContextRollbackResult,
  AgentModelContextSnapshotResult,
  AgentModelAvailability,
  AgentModelSettingsCatalog,
  AgentModelSettingsCatalogResult,
  AgentProviderMutationResult,
  AgentSendMessagePayload,
  AgentSendMessageResult,
  AgentStreamEvent,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexMcpSummary,
  CodexModelContextConfig,
  CodexSessionConfig,
  CodexSessionStatus,
  CodexSkillInput,
  CodexSkillsSummary,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexWorkspacePaths,
  ItemDeltaPatch,
} from '../../types/agent'
import type { AttachmentRef, TimelineItem } from '../../types/agent-timeline'
import { dropSupersededStreamItems, trimRetriedStreamItems } from '../../types/agent-timeline'
import type { AttachmentService } from './AttachmentService'
import type { ThreadStore } from './ThreadStore'
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
import { setFsAllowedRoots } from '../file-explorer/fsIpc'

const EMPTY_KEY_ERROR = '请在设置页填写 Codex Agent API Key'
const CONTEXT_TRANSITION_BUSY_ERROR = '模型上下文配置正在切换，请稍后重试。'

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

class ContextApplyError extends Error {
  constructor(
    readonly stage: AgentModelContextApplyStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ContextApplyError'
  }
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
    if (!saved || !saved.mime.startsWith('image/')) return
    if (attachment.name !== saved.originalName || attachment.mime !== saved.mime) return
    uploadedPathByOriginalPath.set(path.resolve(attachment.path), saved.localPath)
  })

  if (uploadedPathByOriginalPath.size === 0) return items
  return items.map((item) => {
    if (item.type !== 'localImage') return item
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
  private win: BrowserWindow | undefined
  private readonly store: ThreadStore | undefined
  private readonly attachments: AttachmentService | undefined
  private readonly eventSink: ((event: AgentStreamEvent) => void) | undefined
  private readonly userDataDir: string
  private readonly providerStore: CodexProviderStore
  private readonly runtimeSettingsStore: CodexRuntimeSettingsStore
  private runtimeSettings: PersistedCodexRuntimeSettingsV1
  /** User-visible Gateway id exposed by Provider settings snapshots. */
  private activeGatewayId: string
  /** Internal Channel runtime control for backend generation switches. */
  private readonly channelController: ProviderChannelController
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
  /**
   * Synchronously claimed by a Context transaction before it joins the shared
   * lifecycle tail. New send/steer calls fail immediately while the owner is
   * queued, applying, or compensating; a unique token prevents an older
   * transaction's finally handler from clearing a newer owner.
   */
  private contextTransitionOwner: symbol | null = null
  /** True when rollback could not prove which Context config the backend uses. */
  private contextRecoveryRequired = false
  /** Last main-owned apply + rollback summary while effective Context is unknown. */
  private contextRecoveryError: string | undefined

  constructor(opts: AgentManagerOptions) {
    this.win = opts.win
    this.store = opts.store
    this.attachments = opts.attachments
    this.eventSink = opts.eventSink
    this.userDataDir = opts.userDataDir
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
        getModelContextConfig: () => ({
          ...(this.runtimeSettings.pending?.target ?? this.runtimeSettings.confirmed),
        }),
        catimationMcp: opts.mcpRuntime,
        // Unlock experimental-gated RPCs (turn/start.collaborationMode for the
        // composer's Plan preset; collaborationMode/list). Smoke-verified on the
        // bundled binary: initialize + stable RPC behaviour are unaffected.
        experimentalApi: true,
        getUnderstandProvider: () =>
          this.miauToken
            ? { provider: QWEN_UNDERSTAND_PROVIDER, token: this.miauToken }
            : undefined,
        getApiyiKey: () => this.apiyiMcpKey || undefined,
        getCinematographyKbKey: () => this.cinematographyKbKey || undefined,
        getDashVectorKey: () => this.dashVectorKey || undefined,
        onApprovalRequest: (request) => this.emitApprovalRequest(request),
        onMcpNotification: (event) => this.handleMcpNotification(event),
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
        currentEpoch: () => this.backend.currentEpoch?.(),
      },
      paths: this.workspacePaths(),
      initialChannelId: restoredProvider.channelId,
      getCustomProviders: () => this.providerStore.loadSync().customProviders,
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
    await this.enqueueProviderStoreOperation(
      () => this.providerStore.setApiKey(id, next),
    )
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
    const trimmedName = input.name?.trim() ?? ''
    if (!trimmedName) throw new Error('Provider name is required')
    try {
      new URL(input.baseUrl)
    } catch {
      throw new Error('Provider baseUrl must be a valid URL')
    }
    return this.enqueueProviderStoreOperation(
      () => this.providerStore.addCustomProvider({ ...input, name: trimmedName }),
    )
  }

  async updateCustomProvider(
    id: string,
    patch: Partial<Omit<ProviderPreset, 'id' | 'isCustom'>>,
  ): Promise<{ ok: true } & AgentProviderMutationResult> {
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

  async setSessionConfigPatch(input: unknown): Promise<CodexSessionStatus> {
    const patch = validateSessionConfigPatch(input, this.allowedRoots)
    await this.confirmUnsafeSessionConfigChange(patch)
    this.sessionConfig = {
      ...this.sessionConfig,
      ...patch,
      writableRoots: patch.writableRoots ? [...patch.writableRoots] : [...this.sessionConfig.writableRoots],
    }
    this.backend.setSessionConfig?.(patch)
    return this.getSessionStatus()
  }

  getSessionStatus(model: string = DEFAULT_AGENT_MODEL): CodexSessionStatus {
    return {
      model,
      sandboxMode: this.sessionConfig.sandboxMode,
      approvalPolicy: this.sessionConfig.approvalPolicy,
      webSearch: this.sessionConfig.webSearch,
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
      const backendEpoch = this.backend.currentEpoch?.()
      const ownerStillCurrent = (): boolean =>
        this.providerCapabilityBarrier === providerBarrier
        && this.channelController.currentChannelId() === provider
        && (
          backendEpoch === undefined
          || this.backend.currentEpoch?.() === backendEpoch
        )

      if (!providerReady || typeof this.backend.listModels !== 'function') {
        return { ok: true, data: this.fallbackModelSettingsCatalog(provider) }
      }

      try {
        const response = await this.backend.listModels({ includeHidden: false })
        if (!ownerStillCurrent()) continue
        const persisted = this.providerStore.loadSync()
        const dynamicModels = response.data.map((row) => ({
          id: row.id,
          displayName: row.displayName,
          description: row.description,
          hidden: row.hidden,
          isDefault: row.isDefault,
          capabilities: mergeModelSettingsCapabilities({
            model: row.model,
            gatewayId: this.activeGatewayId,
            channelId: resolveGatewayModelRoute(
              this.activeGatewayId,
              row.model,
              persisted.customProviders,
            ).channelId,
            defaultReasoningEffort: row.defaultReasoningEffort,
            supportedReasoningEfforts: row.supportedReasoningEfforts.map(
              (effort) => effort.reasoningEffort,
            ),
          }),
        }))
        const catalog = buildGatewayModelCatalog({
          gatewayId: this.activeGatewayId,
          dynamicSource: 'codex',
          dynamicModels,
          hasCredential: Boolean(this.codexApiKey),
          availabilityByModel: this.modelAvailabilityByGateway.get(
            this.activeGatewayId,
          ) ?? new Map(),
        })
        return { ok: true, data: catalog }
      } catch {
        if (!ownerStillCurrent()) continue
        return { ok: true, data: this.fallbackModelSettingsCatalog(provider) }
      }
    }
    const provider = this.channelController.currentChannelId()
    console.warn(
      `[AgentManager] model settings catalog owner changed ${maxOwnerAttempts} times; using fallback for ${provider}`,
    )
    return { ok: true, data: this.fallbackModelSettingsCatalog(provider) }
  }

  getModelContextConfigRpc(): Promise<AgentModelContextSnapshotResult> {
    return Promise.resolve({
      ok: true,
      data: {
        ...this.runtimeSettings.confirmed,
        recoveryRequired: this.contextRecoveryRequired,
        ...(this.contextRecoveryError
          ? { recoveryError: this.contextRecoveryError }
          : {}),
      },
    })
  }

  /**
   * Apply a Codex context-window change as one transaction on the same
   * Provider/turn lifecycle tail used by send, steer, and Provider replacement.
   *
   * This method deliberately is not `async`: it claims `contextTransitionOwner`
   * synchronously before returning the transaction promise, so a send/steer
   * invoked later in the same tick cannot persist a message and then discover
   * that its backend generation is being replaced.
   */
  applyModelContextRpc(
    payload: AgentModelContextApplyPayload,
  ): Promise<AgentModelContextApplyResult> {
    const previousConfig = { ...this.runtimeSettings.confirmed }
    const attemptedConfig: CodexModelContextConfig = {
      modelContextWindow: payload.contextWindow,
      modelAutoCompactTokenLimit: modelAutoCompactTokenLimit(payload.contextWindow),
    }
    const model = typeof payload.model === 'string' ? payload.model.trim() : ''
    const validationError = this.validateModelContextPayload(
      payload,
      model,
      attemptedConfig,
      this.contextRecoveryRequired
        && sameModelContextConfig(previousConfig, attemptedConfig),
    )
    if (validationError) {
      return Promise.resolve(this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        'validate',
        validationError,
        { ok: true, activeConfig: previousConfig },
      ))
    }

    if (this.contextTransitionOwner !== null) {
      return Promise.resolve(this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        'busy',
        'Another model context transaction is already in progress',
        { ok: true, activeConfig: previousConfig },
      ))
    }

    try {
      this.readModelContextEpochStrict()
    } catch (error) {
      return Promise.resolve(this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        'verify',
        errorMessage(error),
        { ok: true, activeConfig: previousConfig },
      ))
    }

    if (
      !this.contextRecoveryRequired
      && sameModelContextConfig(previousConfig, attemptedConfig)
    ) {
      return Promise.resolve({
        ok: true,
        data: {
          model,
          contextWindow: attemptedConfig.modelContextWindow,
          autoCompactTokenLimit: attemptedConfig.modelAutoCompactTokenLimit,
          threadRestored: false,
          requestVersion: payload.requestVersion,
        },
      })
    }

    if (this.backend.hasInFlightWork?.()) {
      return Promise.resolve(this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        'busy',
        'Current turn is running; retry the model context change after it completes',
        { ok: true, activeConfig: previousConfig },
      ))
    }

    const owner = Symbol('model-context-transition')
    this.contextTransitionOwner = owner
    const transaction = this.restartChain.then(() =>
      this.runModelContextTransaction(
        payload,
        model,
        previousConfig,
        attemptedConfig,
      ))
    this.restartChain = transaction.then(
      () => undefined,
      () => undefined,
    )

    return transaction.finally(() => {
      if (this.contextTransitionOwner === owner) {
        this.contextTransitionOwner = null
      }
    })
  }

  private modelRoute(providerId: string, modelId: string) {
    const persisted = this.providerStore.loadSync()
    const gatewayId = credentialIdForProvider(providerId, persisted.customProviders)
    return resolveGatewayModelRoute(gatewayId, modelId, persisted.customProviders)
  }

  private fallbackModelSettingsCatalog(provider: string): AgentModelSettingsCatalog {
    const gatewayId = credentialIdForProvider(provider)
    return buildGatewayModelCatalog({
      gatewayId,
      dynamicSource: 'fallback',
      dynamicModels: CANONICAL_MODEL_SETTINGS_ROWS.map((row) => {
        const route = this.modelRoute(provider, row.id)
        return {
          id: row.id,
          displayName: row.displayName,
          description: row.description,
          hidden: false,
          isDefault: row.isDefault,
          capabilities: {
            ...mergeModelSettingsCapabilities({
              model: row.id,
              gatewayId: route.gatewayId,
              channelId: route.channelId,
              supportedReasoningEfforts: [],
            }),
            contextOptions: modelContextOptions(
              row.id,
              route.gatewayId,
              route.channelId,
            ).map((option) => ({
              ...option,
              conservative: true,
            })),
          },
        }
      }),
      hasCredential: Boolean(this.codexApiKey),
      availabilityByModel: this.modelAvailabilityByGateway.get(gatewayId)
        ?? new Map(),
    })
  }

  private validateModelContextPayload(
    payload: AgentModelContextApplyPayload,
    model: string,
    attemptedConfig: CodexModelContextConfig,
    allowConfirmedRecovery = false,
  ): string | null {
    if (!model) return 'Model must be a non-empty string'
    if (!Number.isSafeInteger(payload.requestVersion) || payload.requestVersion < 0) {
      return 'requestVersion must be a non-negative safe integer'
    }
    const route = this.modelRoute(this.activeGatewayId, model)
    const allowed = modelContextOptions(
      model,
      route.gatewayId,
      route.channelId,
    ).some(
      (option) => option.value === attemptedConfig.modelContextWindow,
    ) || allowConfirmedRecovery
    if (!allowed) {
      return `Context window ${String(payload.contextWindow)} is not supported for model ${model}`
    }
    return null
  }

  private async runModelContextTransaction(
    payload: AgentModelContextApplyPayload,
    model: string,
    previousConfig: CodexModelContextConfig,
    attemptedConfig: CodexModelContextConfig,
  ): Promise<AgentModelContextApplyResult> {
    const recoveryWasRequired = this.contextRecoveryRequired
    // A send admitted before this request may have published in-flight state
    // while this transaction was waiting behind it on the shared tail.
    if (this.backend.hasInFlightWork?.()) {
      return this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        'busy',
        'Current turn is running; retry the model context change after it completes',
        { ok: true, activeConfig: previousConfig },
      )
    }

    let previousEpoch: number
    try {
      previousEpoch = this.readModelContextEpochStrict()
    } catch (error) {
      return this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        'verify',
        errorMessage(error),
        { ok: true, activeConfig: previousConfig },
      )
    }

    let codexThreadId: string | undefined
    try {
      codexThreadId = await this.resolveModelContextThreadId(payload.threadId)
    } catch (error) {
      return this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        'resume',
        errorMessage(error),
        { ok: true, activeConfig: previousConfig },
      )
    }

    const pendingSettings: PersistedCodexRuntimeSettingsV1 = {
      version: 1,
      confirmed: { ...previousConfig },
      pending: {
        target: { ...attemptedConfig },
        requestVersion: payload.requestVersion,
        startedAt: new Date().toISOString(),
      },
    }
    try {
      await this.runtimeSettingsStore.replace(pendingSettings)
    } catch (error) {
      return this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        'persist',
        errorMessage(error),
        { ok: true, activeConfig: previousConfig },
      )
    }
    // Only a durable pending record may affect the restart getter.
    this.runtimeSettings = cloneRuntimeSettings(pendingSettings)

    let processMayUseTarget = false
    try {
      const restart = this.backend.restartCodex?.bind(this.backend)
      if (!restart) {
        throw new ContextApplyError('restart', 'Codex restart API is unavailable')
      }
      try {
        await this.restartBackendWithGenerationCheck(restart)
        processMayUseTarget = true
      } catch (error) {
        processMayUseTarget = this.modelContextRequiresCompensation(
          previousEpoch,
        )
        throw new ContextApplyError('restart', errorMessage(error), { cause: error })
      }
      const appliedEpoch = this.assertModelContextEpochChanged(previousEpoch)

      if (payload.threadId && codexThreadId) {
        await this.resumeModelContextThreadStrict(
          payload.threadId,
          codexThreadId,
          appliedEpoch,
        )
      }
      await this.refreshModelsForContext()
      this.assertModelContextEpochStable(appliedEpoch)

      const confirmedSettings: PersistedCodexRuntimeSettingsV1 = {
        version: 1,
        confirmed: { ...attemptedConfig },
      }
      try {
        await this.runtimeSettingsStore.replace(confirmedSettings)
      } catch (error) {
        throw new ContextApplyError('persist', errorMessage(error), { cause: error })
      }
      // Never publish an in-memory confirmation before the atomic rename wins.
      this.runtimeSettings = cloneRuntimeSettings(confirmedSettings)
      this.contextRecoveryRequired = false
      this.contextRecoveryError = undefined
      return {
        ok: true,
        data: {
          model,
          contextWindow: attemptedConfig.modelContextWindow,
          autoCompactTokenLimit: attemptedConfig.modelAutoCompactTokenLimit,
          threadRestored: Boolean(payload.threadId && codexThreadId),
          requestVersion: payload.requestVersion,
        },
      }
    } catch (error) {
      const contextError = error instanceof ContextApplyError
        ? error
        : new ContextApplyError('verify', errorMessage(error), { cause: error })
      const rollback = await this.rollbackModelContextOnce({
        previousConfig,
        dbThreadId: payload.threadId,
        codexThreadId,
        restartRequired: processMayUseTarget,
      })
      this.contextRecoveryRequired =
        !rollback.ok || (recoveryWasRequired && !processMayUseTarget)
      if (!rollback.ok) {
        this.contextRecoveryError =
          `Context apply failed: ${contextError.message}; rollback failed: ${rollback.error}`
      } else if (!this.contextRecoveryRequired) {
        this.contextRecoveryError = undefined
      }
      return this.modelContextFailure(
        payload,
        previousConfig,
        attemptedConfig,
        contextError.stage,
        contextError.message,
        rollback,
      )
    }
  }

  private async resolveModelContextThreadId(
    dbThreadId: string | undefined,
  ): Promise<string | undefined> {
    if (!dbThreadId) return undefined
    const mapped = this.codexThreadIdByDbThreadId.get(dbThreadId)
    if (mapped) return mapped
    if (!this.store?.getCodexThreadId) return undefined
    try {
      return (await this.store.getCodexThreadId(dbThreadId)) ?? undefined
    } catch (error) {
      throw new ContextApplyError(
        'resume',
        `Failed to resolve Codex thread ${dbThreadId}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
  }

  private async resumeModelContextThreadStrict(
    dbThreadId: string,
    codexThreadId: string,
    epoch: number,
  ): Promise<void> {
    if (!this.backend.resumeThread) {
      throw new ContextApplyError(
        'resume',
        'Codex strict thread resume API is unavailable',
      )
    }
    try {
      await this.backend.resumeThread(codexThreadId)
      this.codexThreadIdByDbThreadId.set(dbThreadId, codexThreadId)
      this.codexThreadEpochByDbThreadId.set(dbThreadId, epoch)
      await this.store?.setCodexThreadId?.(dbThreadId, codexThreadId)
    } catch (error) {
      throw new ContextApplyError('resume', errorMessage(error), { cause: error })
    }
  }

  private async refreshModelsForContext(): Promise<void> {
    if (!this.backend.listModels) {
      throw new ContextApplyError('verify', 'Codex model list API is unavailable')
    }
    try {
      await this.backend.listModels({ includeHidden: true })
    } catch (error) {
      throw new ContextApplyError('verify', errorMessage(error), { cause: error })
    }
  }

  private readModelContextEpochStrict(): number {
    const currentEpoch = this.backend.currentEpoch
    if (typeof currentEpoch !== 'function') {
      throw new ContextApplyError(
        'verify',
        'Model context apply requires a backend epoch getter',
      )
    }
    const epoch = currentEpoch.call(this.backend)
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new ContextApplyError(
        'verify',
        `Model context backend epoch must be a non-negative safe integer; received ${String(epoch)}`,
      )
    }
    return epoch
  }

  private assertModelContextEpochChanged(previousEpoch: number): number {
    const currentEpoch = this.readModelContextEpochStrict()
    if (currentEpoch === previousEpoch) {
      throw new ContextApplyError(
        'verify',
        'Model context restart did not change backend epoch/generation',
      )
    }
    return currentEpoch
  }

  private assertModelContextEpochStable(expectedEpoch: number): void {
    const currentEpoch = this.readModelContextEpochStrict()
    if (currentEpoch !== expectedEpoch) {
      throw new ContextApplyError(
        'verify',
        'Model context backend epoch/generation changed before confirmation',
      )
    }
  }

  private modelContextRequiresCompensation(previousEpoch: number): boolean {
    try {
      if (this.readModelContextEpochStrict() !== previousEpoch) return true
    } catch {
      // A failed replacement with no valid epoch proof is conservatively
      // treated as possibly switched, forcing compensation instead of claiming
      // that the old process is still authoritative.
      return true
    }

    const isHealthy = this.backend.isHealthy
    if (typeof isHealthy !== 'function') return true
    try {
      // An unchanged epoch only proves that the generation identifier stayed
      // the same. Stop-first restart paths may still have torn down that
      // process, so skipping compensation additionally requires live health.
      return isHealthy.call(this.backend) !== true
    } catch {
      return true
    }
  }

  private async rollbackModelContextOnce(input: {
    previousConfig: CodexModelContextConfig
    dbThreadId?: string
    codexThreadId?: string
    restartRequired: boolean
  }): Promise<AgentModelContextRollbackResult> {
    const previousSettings: PersistedCodexRuntimeSettingsV1 = {
      version: 1,
      confirmed: { ...input.previousConfig },
    }
    const failures: string[] = []
    try {
      await this.runtimeSettingsStore.replace(previousSettings)
    } catch (error) {
      failures.push(`persist: ${errorMessage(error)}`)
    }
    // The getter must point at the previous configuration before any
    // compensating restart, even when the disk cleanup itself failed.
    this.runtimeSettings = cloneRuntimeSettings(previousSettings)

    if (input.restartRequired) {
      const restart = this.backend.restartCodex?.bind(this.backend)
      if (!restart) {
        failures.push('restart: Codex restart API is unavailable')
      } else {
        let previousEpoch: number | undefined
        try {
          previousEpoch = this.readModelContextEpochStrict()
        } catch (error) {
          failures.push(`restart: ${errorMessage(error)}`)
        }

        let restoredEpoch: number | undefined
        if (previousEpoch !== undefined) {
          try {
            await this.restartBackendWithGenerationCheck(restart)
            restoredEpoch = this.assertModelContextEpochChanged(previousEpoch)
          } catch (error) {
            failures.push(`restart: ${errorMessage(error)}`)
          }
        }

        if (restoredEpoch !== undefined) {
          if (input.dbThreadId && input.codexThreadId) {
            try {
              await this.resumeModelContextThreadStrict(
                input.dbThreadId,
                input.codexThreadId,
                restoredEpoch,
              )
            } catch (error) {
              failures.push(`resume: ${errorMessage(error)}`)
            }
          }
          try {
            await this.refreshModelsForContext()
            this.assertModelContextEpochStable(restoredEpoch)
          } catch (error) {
            failures.push(`verify: ${errorMessage(error)}`)
          }
        }
      }
    }

    if (failures.length > 0) {
      return {
        ok: false,
        error: failures.join('; '),
        effectiveConfig: null,
      }
    }
    return {
      ok: true,
      activeConfig: { ...input.previousConfig },
    }
  }

  private modelContextFailure(
    payload: AgentModelContextApplyPayload,
    previousConfig: CodexModelContextConfig,
    attemptedConfig: CodexModelContextConfig,
    stage: AgentModelContextApplyStage,
    error: string,
    rollback: AgentModelContextRollbackResult,
  ): Extract<AgentModelContextApplyResult, { ok: false }> {
    return {
      ok: false,
      error,
      stage,
      previousConfig: { ...previousConfig },
      attemptedConfig: { ...attemptedConfig },
      requestVersion: payload.requestVersion,
      rollback,
    }
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
      if (!modelRow) return fallback()

      const model = modelRow.model
      const route = this.modelRoute(providerId, model)
      const modelSettings = mergeModelSettingsCapabilities({
        model,
        gatewayId: route.gatewayId,
        channelId: route.channelId,
        defaultReasoningEffort: modelRow.defaultReasoningEffort,
        supportedReasoningEfforts: modelRow.supportedReasoningEfforts.map(
          (effort) => effort.reasoningEffort,
        ),
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

  async listMcpServersRpc(params?: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    try {
      if (!this.backend.listMcpServers) throw new Error('MCP list API unavailable')
      const result = await this.backend.listMcpServers(params)
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async batchWriteConfigRpc(edits: unknown[], reload?: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.backend.batchWriteConfig) throw new Error('MCP batch write API unavailable')
      await this.backend.batchWriteConfig(edits, reload)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async writeConfigValueRpc(keyPath: string, value: unknown): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.backend.writeConfigValue) throw new Error('MCP write value API unavailable')
      await this.backend.writeConfigValue(keyPath, value)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async readConfigRpc(): Promise<{ ok: boolean; error?: string; config?: unknown }> {
    try {
      if (!this.backend.readConfig) throw new Error('MCP read config API unavailable')
      const result = await this.backend.readConfig()
      return { ok: true, config: result?.config }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Read `~/.codex/config.toml` directly (bypasses codex's strict schema).
   *
   * Why this exists separately from `readConfigRpc`:
   *   The Rust `config/read` RPC rejects the entire request if any
   *   `[mcp_servers.X]` block fails validation (e.g. unknown `transport`
   *   value). The renderer must still be able to enumerate and EDIT the
   *   broken section to fix it — without this RPC the MCP page is a dead
   *   end whenever codex's parser tightens. We deliberately surface
   *   whatever TOML the user has on disk, even when codex would reject it.
   */
  async readRawConfigRpc(): Promise<{
    ok: boolean
    error?: string
    config?: Record<string, unknown> | null
    raw?: string | null
    parseError?: string
  }> {
    try {
      const configPath = path.join(os.homedir(), '.codex', 'config.toml')
      const result = await readRawCodexConfig(configPath)
      return {
        ok: true,
        config: result.config,
        raw: result.raw,
        parseError: result.parseError,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async reloadMcpServersRpc(): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.backend.reloadMcpServers) throw new Error('MCP reload API unavailable')
      await this.backend.reloadMcpServers()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async mcpOAuthLoginRpc(name: string): Promise<{ ok: boolean; error?: string; authorization_url?: string }> {
    try {
      if (!this.backend.mcpOAuthLogin) throw new Error('MCP OAuth API unavailable')
      const result = await this.backend.mcpOAuthLogin(name)
      return { ok: true, authorization_url: result?.authorization_url }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

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

  // ─── Native plugin / marketplace / apps / external-agent-import (≥0.140) ───
  // Each delegates to the backend passthrough and wraps the result in the
  // standard `{ ok, error?, data? }` envelope so the renderer never has to
  // try/catch across the IPC boundary. The "API unavailable" guard fires when
  // the active backend is non-Codex or hasn't been started yet.

  async listPluginsRpc(params?: PluginListParams): Promise<{ ok: boolean; error?: string; data?: PluginListResponse }> {
    try {
      if (!this.backend.listPlugins) throw new Error('Plugin list API unavailable')
      return { ok: true, data: await this.backend.listPlugins(params) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async listInstalledPluginsRpc(
    params?: PluginInstalledParams,
  ): Promise<{ ok: boolean; error?: string; data?: PluginInstalledResponse }> {
    try {
      if (!this.backend.listInstalledPlugins) throw new Error('Installed plugins API unavailable')
      return { ok: true, data: await this.backend.listInstalledPlugins(params) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async readPluginRpc(params: PluginReadParams): Promise<{ ok: boolean; error?: string; data?: PluginReadResponse }> {
    try {
      if (!this.backend.readPlugin) throw new Error('Plugin read API unavailable')
      return { ok: true, data: await this.backend.readPlugin(params) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async installPluginRpc(
    params: PluginInstallParams,
  ): Promise<{ ok: boolean; error?: string; data?: PluginInstallResponse }> {
    try {
      if (!this.backend.installPlugin) throw new Error('Plugin install API unavailable')
      return { ok: true, data: await this.backend.installPlugin(params) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async uninstallPluginRpc(pluginId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.backend.uninstallPlugin) throw new Error('Plugin uninstall API unavailable')
      await this.backend.uninstallPlugin(pluginId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async addMarketplaceRpc(
    params: MarketplaceAddParams,
  ): Promise<{ ok: boolean; error?: string; data?: MarketplaceAddResponse }> {
    try {
      if (!this.backend.addMarketplace) throw new Error('Marketplace add API unavailable')
      return { ok: true, data: await this.backend.addMarketplace(params) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async removeMarketplaceRpc(
    marketplaceName: string,
  ): Promise<{ ok: boolean; error?: string; data?: MarketplaceRemoveResponse }> {
    try {
      if (!this.backend.removeMarketplace) throw new Error('Marketplace remove API unavailable')
      return { ok: true, data: await this.backend.removeMarketplace(marketplaceName) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async upgradeMarketplacesRpc(
    marketplaceName?: string,
  ): Promise<{ ok: boolean; error?: string; data?: MarketplaceUpgradeResponse }> {
    try {
      if (!this.backend.upgradeMarketplaces) throw new Error('Marketplace upgrade API unavailable')
      return { ok: true, data: await this.backend.upgradeMarketplaces(marketplaceName) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async listAppsRpc(params?: AppsListParams): Promise<{ ok: boolean; error?: string; data?: AppsListResponse }> {
    try {
      if (!this.backend.listApps) throw new Error('Apps list API unavailable')
      return { ok: true, data: await this.backend.listApps(params) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async detectExternalAgentConfigRpc(
    params?: ExternalAgentConfigDetectParams,
  ): Promise<{ ok: boolean; error?: string; data?: ExternalAgentConfigDetectResponse }> {
    try {
      if (!this.backend.detectExternalAgentConfig) throw new Error('External agent config detect API unavailable')
      return { ok: true, data: await this.backend.detectExternalAgentConfig(params) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async importExternalAgentConfigRpc(
    migrationItems: ExternalAgentConfigMigrationItem[],
  ): Promise<{ ok: boolean; error?: string; data?: ExternalAgentConfigImportResponse }> {
    try {
      if (!this.backend.importExternalAgentConfig) throw new Error('External agent config import API unavailable')
      return { ok: true, data: await this.backend.importExternalAgentConfig(migrationItems) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

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
    if (this.contextTransitionOwner !== null) {
      const threadId = payload.threadId ?? 'pending'
      this.emitEvent({
        type: 'error',
        threadId,
        error: CONTEXT_TRANSITION_BUSY_ERROR,
      })
      throw new Error(CONTEXT_TRANSITION_BUSY_ERROR)
    }
    return this.enqueueTurnAdmission(
      () => this.sendMessageAfterProviderBarrier(payload),
    )
  }

  private async sendMessageAfterProviderBarrier(
    payload: AgentSendMessagePayload,
  ): Promise<AgentSendMessageResult> {
    if (!this.codexApiKey) {
      const threadId = payload.threadId ?? 'pending'
      this.emitEvent({ type: 'error', threadId, error: EMPTY_KEY_ERROR })
      throw new Error(EMPTY_KEY_ERROR)
    }

    if (!this.store || !this.attachments) {
      throw new Error('AgentManager.sendMessage called without store/attachments')
    }

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

    const assembled = await this.assembleTurnInput(payload, true)
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
    return { threadId, userMessageItems: cloneableItems }
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
    if (this.contextTransitionOwner !== null) {
      const threadId = threadIdIn ?? 'pending'
      this.emitEvent({
        type: 'error',
        threadId,
        error: CONTEXT_TRANSITION_BUSY_ERROR,
      })
      throw new Error(CONTEXT_TRANSITION_BUSY_ERROR)
    }
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
    return this.enqueueTurnAdmission(
      () => this.steerAfterProviderBarrier(payload, threadIdIn, steer),
    )
  }

  private async steerAfterProviderBarrier(
    payload: AgentSendMessagePayload,
    threadIdIn: string,
    steer: NonNullable<IAgentBackend['steer']>,
  ): Promise<AgentSendMessageResult> {
    if (!this.codexApiKey) {
      this.emitEvent({ type: 'error', threadId: threadIdIn, error: EMPTY_KEY_ERROR })
      throw new Error(EMPTY_KEY_ERROR)
    }
    if (!this.store || !this.attachments) {
      throw new Error('AgentManager.steer called without store/attachments')
    }
    try {
      await this.ensureBackendStarted()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const message = `Codex 后端启动失败:${detail}`
      this.emitEvent({ type: 'error', threadId: threadIdIn, error: message })
      throw new Error(message)
    }

    const assembled = await this.assembleTurnInput(payload, true)
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
    return { threadId, userMessageItems: cloneableItems }
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
    const thread = payload.threadId
      ? { id: payload.threadId }
      : await this.store.createThread({
          title: payload.content.slice(0, 40) || 'New Agent Thread',
          model,
        })
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
      const savedMessage = await this.store.addMessage({ threadId: thread.id, role: 'user', items: userJsonItems })
      // Official-compat: forward our persisted row id as the app-server v2
      // `clientUserMessageId` — the rollout's `userMessage` item echoes it as
      // `clientId`, so codex-native history (thread/read, fork, resume) maps
      // 1:1 to our DB rows without content heuristics.
      clientUserMessageId = savedMessage?.id
      // best-effort: failing to bump lastMessageAt should not block the turn
      await this.store.updateLastMessageAt(thread.id).catch(() => undefined)
    }

    const input: AgentInput = {
      ...payload,
      model,
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      clientUserMessageId,
      items,
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
  }

  /**
   * Reverse-map a Codex thread UUID (from an MCP tool call's `_meta`) to our DB
   * thread id. Used by the MCP ToolRouter so renderer tools (e.g.
   * `generate_image`) can attribute their UI to the chat that requested them.
   * Returns `undefined` when the mapping isn't known yet.
   */
  resolveDbThreadId(codexThreadId: string): string | undefined {
    return findDbThreadId(this.codexThreadIdByDbThreadId, codexThreadId)
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

  async deleteThread(threadId: string): Promise<void> {
    if (!this.store) throw new Error('AgentManager.deleteThread called without store')
    return this.store.deleteThread(threadId)
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
    if (this.eventSink) {
      this.eventSink(event)
      return
    }
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('agent:event', event)
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
  private rememberCodexThread(dbThreadId: string, codexThreadId: string): void {
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
        await this.backend.resumeThread(id)
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
      await this.backend.resumeThread(persisted)
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
      try {
        for await (const event of eventStream) {
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
          // Renderer's chat store filters events by its DB threadId. Always rewrite
          // so codex-side UUIDs never leak into the UI layer. Out-of-band variants
          // (mcp_*, skills_changed, notice) carry no threadId — forward untouched.
          this.emitEvent('threadId' in event ? { ...event, threadId: dbThreadId } : event)

          assistantItems = applyAssistantEvent(assistantItems, event)

          if (event.type === 'turn_completed') {
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

function sameModelContextConfig(
  left: CodexModelContextConfig,
  right: CodexModelContextConfig,
): boolean {
  return (
    left.modelContextWindow === right.modelContextWindow
    && left.modelAutoCompactTokenLimit === right.modelAutoCompactTokenLimit
  )
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
