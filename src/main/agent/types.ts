import type {
  AgentSendMessagePayload,
  AgentStreamEvent,
  CodexApprovalResponse,
  CodexSessionConfig,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexWorkspacePaths,
} from '../../types/agent'
import type { CodexProviderConfig } from './codexLaunch'
import type {
  CodexCollaborationMode,
  CodexModelListParams,
  CodexModelListResponse,
  CodexThreadConfigOverrides,
  CodexThreadMemoryMode,
  CollaborationModeListResponse,
  ThreadSettingsUpdateParams,
  ThreadSettingsUpdateResponse,
} from './codexProtocol'
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
import type {
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  ThreadGoalGetResponse,
  ThreadGoalClearResponse,
} from '../../types/codexGoals'

export type {
  AgentModelContextApplyPayload,
  AgentModelContextApplyResult,
  AgentModelContextApplyStage,
  AgentModelContextRollbackResult,
  AgentModelSelectionRecoveryResult,
} from '../../types/agent'

export interface AgentInput extends AgentSendMessagePayload {
  model: string
  cwd: string
  /**
   * Codex app-server v2 `clientUserMessageId` for `turn/start` / `turn/steer`.
   * Optional; when supplied, the rollout's `userMessage` item echoes it back
   * as `clientId`. We pass our persisted AgentMessage row id so codex-native
   * history (thread/read, fork, resume) can be reconciled 1:1 against our DB
   * rows without text-content heuristics.
   */
  clientUserMessageId?: string
  /**
   * EXPERIMENTAL Codex collaboration-mode preset for `turn/start` (requires
   * the backend to have initialized with `capabilities.experimentalApi`).
   * Takes precedence over model/effort/instructions for this and subsequent
   * turns. Omitted = today's behaviour.
   */
  collaborationMode?: CodexCollaborationMode
  /**
   * Per-thread provider routing (Plan B). When set on a NEW-thread send, the
   * `thread/start` request carries `modelProvider` so the thread is pinned to
   * this registered `[model_providers.<id>]` table — which may be a sibling
   * Channel of the active Gateway — instead of the process-active provider.
   * Omitted = today's behaviour (active provider).
   */
  modelProvider?: string
  /**
   * Per-thread context pin (Plan B). When set on a NEW-thread send, emitted
   * as thread-scoped `model_context_window` / `model_auto_compact_token_limit`
   * inside `thread/start.config`. `null`/omitted = unpinned (codex resolves
   * from native per-model metadata).
   */
  threadContextPin?: {
    modelContextWindow: number
    modelAutoCompactTokenLimit: number
  } | null
  items: Array<
    | { type: 'text'; text: string }
    | { type: 'localImage'; path: string }
    | { type: 'image'; url: string }
    | { type: 'localAudio'; path: string }
    | { type: 'audio'; url: string }
    | { type: 'skill'; name: string; path: string }
    | { type: 'mention'; name: string; path: string }
  >
}

/**
 * Subset of the app-server v2 `ThreadListParams` the desktop UI forwards.
 * `archived: true` returns only archived threads; `false`/omitted returns only
 * active ones. `searchTerm` is a substring match on the extracted thread title.
 */
export interface ListThreadsParams {
  archived?: boolean
  searchTerm?: string
}

export interface IAgentBackend {
  start(): Promise<void>
  stop(): Promise<void>
  send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent>
  cancel(threadId: string): Promise<void>
  /**
   * Append user input to the in-flight turn without starting a new one
   * (Codex `turn/steer`). Optional so alternate/mocked backends need not
   * implement it; callers must feature-detect. Returns the accepted turnId.
   */
  steer?(threadId: string, input: AgentInput): Promise<string>
  isHealthy(): boolean
  /**
   * True while a send is entering a turn or a turn remains active. Backends
   * that expose runtime restart controls use this to reject unsafe restarts.
   */
  hasInFlightWork?(): boolean
  /** True only while at least one Codex turn is active. */
  hasActiveTurns?(): boolean
  /**
   * Thread-scoped busy probe (Plan B per-thread routing): true only when the
   * given CODEX thread has an active turn. Lets in-process provider switches
   * gate on the TARGET thread alone instead of the whole process.
   */
  hasInFlightWorkForThread?(codexThreadId: string): boolean
  /**
   * True when the LIVE spawn registered `[model_providers.<channelId>]` (the
   * active channel or an extra sibling table). Only such channels can be
   * targeted by in-process `thread/start.modelProvider` routing — anything
   * else needs the restart transaction. Absent = no in-process routing.
   */
  hasRegisteredProviderChannel?(channelId: string): boolean
  /**
   * Monotonic generation counter that increments every time the underlying
   * agent process is (re)spawned — crash self-heal via `start()`, or a
   * provider/config `restartCodex()`. Lets `AgentManager` detect that a
   * previously minted thread id belongs to a DEAD app-server generation (its
   * in-memory thread is gone, since codex keeps threads per-process) and start
   * a FRESH thread instead of wedging the conversation on a stale id that the
   * new process 404s on. Optional: backends that never respawn (or test stubs)
   * may omit it, in which case the manager treats every id as belonging to the
   * current generation (legacy behavior).
   */
  currentEpoch?(): number
  /**
   * Reload a previously persisted thread (by codex thread id) from disk into the
   * CURRENT app-server generation via the v2 `thread/resume` RPC, so a following
   * `send()` with the same id appends to it instead of 404ing. Used to preserve
   * conversation context across a respawn (crash self-heal / provider switch)
   * rather than dropping it. Rejects if the thread can't be resumed (gone,
   * archived, oversized, or the param shape is unsupported by the binary), in
   * which case the manager falls back to starting a fresh thread. Optional:
   * backends without a resumable on-disk store (or test stubs) may omit it.
   * `overrides` (Plan B) pins the resumed thread to its OWN channel/model
   * route; omitted = the backend defaults to the process-active provider.
   */
  resumeThread?(threadId: string, overrides?: CodexThreadConfigOverrides): Promise<void>
  /**
   * Permanently delete a persisted thread and its on-disk rollout
   * (`thread/delete`). Called when the user deletes a conversation so the
   * `.jsonl` under `$CODEX_HOME/sessions/` goes away with the local row —
   * otherwise the rollout leaks forever and still shows up in `thread/list`.
   * Best-effort at the call site: the local delete is authoritative.
   */
  deleteThread?(threadId: string): Promise<void>
  setSessionConfig?(patch: Partial<CodexSessionConfig>): void
  /**
   * Swap the active model provider. The new value is consumed on the next
   * `restartCodex()` — implementations are not required to mutate a running
   * codex process, only the next spawn.
   */
  setProvider?(provider: CodexProviderConfig | undefined): void
  respondToApprovalResponse?(response: CodexApprovalResponse): Promise<void> | void
  listThreads?(params?: ListThreadsParams): Promise<CodexThreadSummary[]>
  readThread?(threadId: string): Promise<CodexThreadDetail>
  /**
   * `lastTurnId` = fork through that turn INCLUSIVE, omitting everything
   * after it (codex 0.145 ThreadForkParams) — the edit-and-resend
   * "server-side context branch" primitive. Omitted = full-history fork.
   */
  forkThread?(
    threadId: string,
    overrides?: CodexThreadConfigOverrides,
    lastTurnId?: string,
  ): Promise<CodexThreadSummary>
  /**
   * Drop this connection's turn/item-event subscription for a codex thread
   * (`thread/unsubscribe`). Used after an in-process provider switch forks a
   * conversation off its old codex thread: unsubscribing the abandoned source
   * lets codex unload it after its idle window instead of pinning it in
   * memory forever.
   */
  unsubscribeThread?(threadId: string): Promise<void>
  archiveThread?(threadId: string): Promise<void>
  unarchiveThread?(threadId: string): Promise<CodexThreadSummary>
  /** Run `codex doctor --json` against the bundled binary (install diagnostics). */
  runDoctor?(): Promise<DoctorReport>
  applyConfigChange?(paths: CodexWorkspacePaths): Promise<void>
  restartCodex?(paths: CodexWorkspacePaths): Promise<void>

  // MCP Management (via Codex app-server RPC)
  listMcpServers?(params?: unknown): Promise<unknown>
  batchWriteConfig?(edits: unknown[], reloadUserConfig?: boolean): Promise<void>
  writeConfigValue?(keyPath: string, value: unknown): Promise<void>
  readConfig?(): Promise<{ config: Record<string, unknown> }>
  listModels?(params?: CodexModelListParams): Promise<CodexModelListResponse>
  reloadMcpServers?(): Promise<void>
  mcpOAuthLogin?(name: string): Promise<{ authorization_url: string }>

  // Native `/goal` (thread/goal/*, app-server v2). Optional — non-Codex
  // backends omit them; the AgentManager RPC wrappers guard on presence.
  setThreadGoal?(params: ThreadGoalSetParams): Promise<ThreadGoalSetResponse>
  getThreadGoal?(threadId: string): Promise<ThreadGoalGetResponse>
  clearThreadGoal?(threadId: string): Promise<ThreadGoalClearResponse>

  // Native manual context compaction (thread/compact/start, app-server v2).
  // Optional — non-Codex backends omit it; the AgentManager RPC wrapper guards.
  compactThread?(threadId: string): Promise<Record<string, never>>

  // Cross-session memory (memories feature; `thread/memoryMode/set` +
  // `memory/reset`, both `#[experimental]` @ rust-v0.145.0 — need the
  // `experimentalApi` initialize capability). Optional — non-Codex backends
  // omit them; the AgentManager RPC wrappers guard on presence.
  setThreadMemoryMode?(threadId: string, mode: CodexThreadMemoryMode): Promise<Record<string, never>>
  resetMemory?(): Promise<Record<string, never>>

  /**
   * `collaborationMode/list` (EXPERIMENTAL, needs `experimentalApi`). Returns
   * the built-in preset masks — per upstream README the Plan preset selects
   * medium reasoning effort and presets never select a model. The manager
   * consumes the Plan mask when expanding the composer's 'plan' kind instead
   * of hardcoding settings. Optional: non-Codex backends / stubs omit it;
   * Plan Auto then resolves through the shared safe default (`medium`).
   */
  listCollaborationModes?(): Promise<CollaborationModeListResponse>
  updateThreadSettings?(
    params: ThreadSettingsUpdateParams,
  ): Promise<ThreadSettingsUpdateResponse>

  // Native plugin / marketplace / apps / external-agent-import (app-server v2,
  // ≥0.140). Codex-specific — optional so non-Codex backends can omit them.
  listPlugins?(params?: PluginListParams): Promise<PluginListResponse>
  listInstalledPlugins?(params?: PluginInstalledParams): Promise<PluginInstalledResponse>
  readPlugin?(params: PluginReadParams): Promise<PluginReadResponse>
  installPlugin?(params: PluginInstallParams): Promise<PluginInstallResponse>
  uninstallPlugin?(pluginId: string): Promise<void>
  addMarketplace?(params: MarketplaceAddParams): Promise<MarketplaceAddResponse>
  removeMarketplace?(marketplaceName: string): Promise<MarketplaceRemoveResponse>
  upgradeMarketplaces?(marketplaceName?: string): Promise<MarketplaceUpgradeResponse>
  listApps?(params?: AppsListParams): Promise<AppsListResponse>
  detectExternalAgentConfig?(params?: ExternalAgentConfigDetectParams): Promise<ExternalAgentConfigDetectResponse>
  importExternalAgentConfig?(migrationItems: ExternalAgentConfigMigrationItem[]): Promise<ExternalAgentConfigImportResponse>
}

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}
