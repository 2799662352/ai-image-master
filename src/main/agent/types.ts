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

export interface AgentInput extends AgentSendMessagePayload {
  model: string
  cwd: string
  items: Array<
    | { type: 'text'; text: string }
    | { type: 'localImage'; path: string }
    | { type: 'image'; url: string }
    | { type: 'skill'; name: string; path: string }
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
   */
  resumeThread?(threadId: string): Promise<void>
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
  forkThread?(threadId: string): Promise<CodexThreadSummary>
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
