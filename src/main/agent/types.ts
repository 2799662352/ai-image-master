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
  isHealthy(): boolean
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
