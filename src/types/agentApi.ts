/**
 * `window.electronAPI.agent` 的唯一契约。
 *
 * 这份接口原先内联在 `src/preload/index.ts` 的 `ElectronAPI` 里,渲染层拿不到,
 * 于是每个消费者(六个 agent-workspace Section、AgentChatPanel、AgentToolExecutor、
 * file-explorer store……)各自手写一份 duck-type 子集。同一个方法的签名在仓库里
 * 存在十几份副本,主进程改了返回值形状,渲染层的副本不会报错 —— 类型检查在这条
 * 边界上等于没开。搬到 `src/types/` 让 preload 与渲染层同吃一份定义,签名从此
 * 只有一处可改。
 *
 * 这里只放**类型**:`src/types/` 是被 main / preload / renderer 三边共享的叶子
 * 目录,不能引入运行时代码。读取 `window` 的辅助函数在
 * `src/renderer/src/utils/agentBridge.ts`。
 */

import type {
  AgentApiResult,
  AgentCancelPayload,
  AgentCollaborationCapabilitiesResult,
  AgentCollaborationModeUpdatePayload,
  AgentCollaborationModeUpdateResult,
  AgentModelContextApplyPayload,
  AgentModelContextApplyResult,
  AgentModelContextSnapshotResult,
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
  AgentModelSelectionRecoveryResult,
  AgentModelSettingsCatalogResult,
  AgentProviderMutationResult,
  AgentSendMessagePayload,
  AgentSendMessageResult,
  AgentStreamEvent,
  AgentThreadBranchResult,
  AgentThreadSummary,
  AgentToolRequest,
  AgentToolResponse,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexAuditLogEntry,
  CodexMcpSummary,
  CodexSessionConfig,
  CodexSessionStatus,
  CodexSkillInput,
  CodexSkillListItem,
  CodexSkillsSummary,
  CodexThreadDetail,
  CodexThreadSummary,
  DoctorReport,
  ImageTaskUpdate,
} from './agent'
import type { EditRequestQueueStatus } from './canvas'
import type { IpcResponse } from './index'
import type { GoalRpcResult, ThreadGoal, ThreadGoalStatus } from './codexGoals'
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
} from './codexPlugins'

/**
 * Provider / Gateway 的 IPC DTO(`getProviders` / `getGateways` 返回的元素),
 * 即主进程 `ProviderPreset`(`src/main/agent/codexProviders.ts`)跨 IPC 后渲染层
 * 能看到的形状。preload 与 `useSettingsStore`(那边叫 `CodexProvider`)此前各存
 * 一份逐字相同的副本,现在统一到这里。
 */
export interface CodexProviderRecord {
  id: string
  name: string
  baseUrl: string
  envKey: string
  model?: string
  reasoningEffort?: string
  verbosity?: string
  credentialId?: string
  allowedModels?: readonly string[]
  requiresOpenaiAuth?: boolean
  extraTopLevelConfig?: Record<string, string | boolean | number>
  description?: string
  /** True for user-added custom providers. Builtins always omit this flag. */
  isCustom?: boolean
}

/**
 * `addCustomProvider` / `updateCustomProvider` 的入参,字段与主进程
 * `validateCustomProviderInput`(`src/main/agent/ipc.ts`)接受的一致。
 * `useSettingsStore` 那份副本少了 `id?`,合并后按验证器的口径为准。
 */
export interface CodexCustomProviderInput {
  /** 省略时由主进程从 name 派生。 */
  id?: string
  name: string
  baseUrl: string
  envKey?: string
  model?: string
  reasoningEffort?: string
  verbosity?: string
  requiresOpenaiAuth?: boolean
  extraTopLevelConfig?: Record<string, string | boolean | number>
  description?: string
}

export type CodexProviderMutationResponse = {
  ok: boolean
  error?: string
} & Partial<AgentProviderMutationResult>

/** Renderer-safe user-facing Gateway snapshot during the Provider migration. */
export interface CodexGatewaySnapshotResponse {
  ok: boolean
  error?: string
  builtins?: CodexProviderRecord[]
  custom?: CodexProviderRecord[]
  activeId?: string
  apiKeys?: Record<string, string>
}

/**
 * `onGoal` 的载荷。主进程 `handleGoalNotification` 只转发这两个变体(并把
 * codex 线程 id 换成 DB id),写成联合而不是 `any`,渲染层就能靠 `switch`
 * 穷尽处理。
 */
export type AgentGoalEvent = Extract<
  AgentStreamEvent,
  { type: 'goal_updated' } | { type: 'goal_cleared' }
>

/**
 * `onMcpStatus` 的载荷。主进程 `handleMcpNotification` 只转发这两个变体
 * (见 `CodexProtocolClient` 的 out-of-band 分流)。
 */
export type AgentMcpStatusEvent = Extract<
  AgentStreamEvent,
  { type: 'mcp_status_updated' } | { type: 'mcp_oauth_completed' }
>

export interface AgentApi {
  sendMessage: (payload: AgentSendMessagePayload) => Promise<AgentSendMessageResult>
  steer: (payload: AgentSendMessagePayload) => Promise<AgentSendMessageResult>
  cancel: (payload: AgentCancelPayload) => Promise<IpcResponse>
  listThreads: () => Promise<AgentThreadSummary[]>
  loadThread: (threadId: string) => Promise<unknown>
  openThread: (threadId: string) => Promise<unknown>
  renameThread: (threadId: string, title: string) => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
  onEvent: (handler: (event: AgentStreamEvent) => void) => () => void
  onToolRequest: (handler: (request: AgentToolRequest) => void) => () => void
  onApprovalRequest: (handler: (request: CodexApprovalRequest) => void) => () => void
  sendToolResponse: (response: AgentToolResponse) => void
  sendImageTaskUpdate: (update: ImageTaskUpdate) => void
  submitCanvasEditRequest: (request: unknown) => void
  getCanvasEditQueueStatus: () => Promise<EditRequestQueueStatus>
  respondApproval: (response: CodexApprovalResponse) => Promise<AgentApiResult>
  setApiKey: (key: string) => Promise<AgentApiResult>
  testConnection: () => Promise<AgentApiResult>
  getSessionStatus: () => Promise<CodexSessionStatus>
  setSessionConfig: (
    patch: Partial<CodexSessionConfig>,
    options?: { persist?: boolean },
  ) => Promise<CodexSessionStatus>
  resetSessionConfig: () => Promise<CodexSessionStatus>
  getCollaborationCapabilities: (model: string) => Promise<AgentCollaborationCapabilitiesResult>
  updateCollaborationMode: (
    payload: AgentCollaborationModeUpdatePayload,
  ) => Promise<AgentCollaborationModeUpdateResult>
  /** Returns user-facing Gateway records while legacy Provider UI remains available. */
  getGateways: () => Promise<CodexGatewaySnapshotResponse>
  /** Activates a user-facing Gateway through the main-process transaction. */
  setActiveGateway: (id: string) => Promise<CodexProviderMutationResponse>
  /** Updates a Gateway credential without exposing ipcRenderer to the renderer. */
  setGatewayApiKey: (id: string, key: string) => Promise<CodexProviderMutationResponse>
  getModelSettingsCatalog: () => Promise<AgentModelSettingsCatalogResult>
  getModelContextConfig: () => Promise<AgentModelContextSnapshotResult>
  applyModelContext: (
    payload: AgentModelContextApplyPayload,
  ) => Promise<AgentModelContextApplyResult>
  /** Applies one authoritative Gateway/model/context selection transaction. */
  applyModelSelection: (
    payload: AgentModelSelectionApplyPayload,
  ) => Promise<AgentModelSelectionApplyResult>
  recoverModelSelection: () => Promise<AgentModelSelectionRecoveryResult>
  setAllowedRoots: (roots: string[]) => Promise<string[]>
  getMcpSummary: () => Promise<CodexMcpSummary>
  getSkillsSummary: () => Promise<CodexSkillsSummary>
  listSkills: () => Promise<CodexSkillListItem[]>
  getSkillDetail: (id: string) => Promise<CodexSkillInput | null>
  saveSkill: (input: CodexSkillInput) => Promise<AgentApiResult & { id?: string }>
  deleteSkill: (id: string) => Promise<AgentApiResult>
  openSkillsRoot: (
    scope: 'repo' | 'user' | 'system',
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string; path?: string }>
  getWorkspaceLogs: (opts?: { limit?: number; sinceIso?: string }) => Promise<CodexAuditLogEntry[]>
  restartCodex: () => Promise<AgentApiResult>
  listCodexThreads: (params?: {
    archived?: boolean
    searchTerm?: string
  }) => Promise<CodexThreadSummary[]>
  readCodexThread: (threadId: string) => Promise<CodexThreadDetail>
  forkCodexThread: (threadId: string) => Promise<CodexThreadSummary>
  /**
   * Edit-and-resend server-side context branch: fork the codex thread
   * before the edited message's turn (`thread/fork` + `lastTurnId`) and
   * truncate DB rows at/after the edit point. `data.branched === false`
   * = degraded to legacy same-thread resend (renderer proceeds unchanged).
   */
  branchThreadBeforeMessage: (
    threadId: string,
    messageId: string,
  ) => Promise<{ ok: boolean; error?: string; data?: AgentThreadBranchResult }>
  archiveCodexThread: (threadId: string) => Promise<AgentApiResult>
  unarchiveCodexThread: (
    threadId: string,
  ) => Promise<{ ok: boolean; error?: string; thread?: CodexThreadSummary }>
  codexDoctor: () => Promise<{ ok: boolean; error?: string; report?: DoctorReport }>
  listMcpServersRpc: (params?: unknown) => Promise<{ ok: boolean; error?: string; data?: unknown }>
  batchWriteConfig: (edits: unknown[], reload?: boolean) => Promise<{ ok: boolean; error?: string }>
  writeConfigValue: (keyPath: string, value: unknown) => Promise<{ ok: boolean; error?: string }>
  reloadMcpServers: () => Promise<{ ok: boolean; error?: string }>
  mcpOAuthLogin: (
    name: string,
  ) => Promise<{ ok: boolean; error?: string; authorization_url?: string }>
  /**
   * 走 Rust `config/read` 拿解析后的 TOML 表。只保证顶层是表:再往下
   * (`config.mcp_servers[name].disabled_tools`)每一层都是 `unknown`,
   * 消费者必须自己校验形状 —— 主进程只做转发,不做 schema 校验。
   */
  readConfig: () => Promise<{
    ok: boolean
    error?: string
    config?: Record<string, unknown>
  }>
  readRawConfig: () => Promise<{
    ok: boolean
    error?: string
    config?: Record<string, unknown> | null
    raw?: string | null
    parseError?: string
  }>
  getMcpStatusSnapshot: () => Promise<{
    ok: boolean
    snapshot?: Record<string, { status: string; error: string | null }>
    error?: string
  }>
  // Codex native `/goal` (thread/goal/*). threadId = DB thread id.
  setGoal: (
    threadId: string,
    params: { objective?: string; tokenBudget?: number; status?: ThreadGoalStatus },
  ) => Promise<GoalRpcResult<ThreadGoal>>
  getGoal: (threadId: string) => Promise<GoalRpcResult<ThreadGoal | null>>
  clearGoal: (threadId: string) => Promise<GoalRpcResult<{ cleared: boolean }>>
  onGoal: (handler: (event: AgentGoalEvent) => void) => () => void
  compactThread: (threadId: string) => Promise<GoalRpcResult<{ started: boolean }>>
  // Cross-session memory (thread/memoryMode/set + memory/reset, 0.145
  // experimental surface). threadId = DB thread id; reset is global.
  setThreadMemoryMode: (
    threadId: string,
    mode: 'enabled' | 'disabled',
  ) => Promise<{ ok: boolean; error?: string }>
  /**
   * Persist the thread's memory choice and apply it when a codex thread exists,
   * replaying it onto later ones. Prefer this over `setThreadMemoryMode` from
   * UI: it works before the first message, which is when the choice is usually
   * made. `pushed: false` means saved-but-not-yet-live, not a failure.
   */
  declareThreadMemoryMode: (
    threadId: string,
    mode: 'enabled' | 'disabled',
  ) => Promise<{ ok: boolean; error?: string; pushed?: boolean }>
  resetMemory: () => Promise<{ ok: boolean; error?: string }>
  // Codex native plugin / marketplace / apps / external-agent-import (≥0.140)
  listPlugins: (
    params?: PluginListParams,
  ) => Promise<{ ok: boolean; error?: string; data?: PluginListResponse }>
  listInstalledPlugins: (
    params?: PluginInstalledParams,
  ) => Promise<{ ok: boolean; error?: string; data?: PluginInstalledResponse }>
  readPlugin: (
    params: PluginReadParams,
  ) => Promise<{ ok: boolean; error?: string; data?: PluginReadResponse }>
  installPlugin: (
    params: PluginInstallParams,
  ) => Promise<{ ok: boolean; error?: string; data?: PluginInstallResponse }>
  uninstallPlugin: (pluginId: string) => Promise<{ ok: boolean; error?: string }>
  addMarketplace: (
    params: MarketplaceAddParams,
  ) => Promise<{ ok: boolean; error?: string; data?: MarketplaceAddResponse }>
  removeMarketplace: (
    marketplaceName: string,
  ) => Promise<{ ok: boolean; error?: string; data?: MarketplaceRemoveResponse }>
  upgradeMarketplaces: (
    marketplaceName?: string,
  ) => Promise<{ ok: boolean; error?: string; data?: MarketplaceUpgradeResponse }>
  listApps: (
    params?: AppsListParams,
  ) => Promise<{ ok: boolean; error?: string; data?: AppsListResponse }>
  detectExternalAgentConfig: (
    params?: ExternalAgentConfigDetectParams,
  ) => Promise<{ ok: boolean; error?: string; data?: ExternalAgentConfigDetectResponse }>
  importExternalAgentConfig: (
    migrationItems: ExternalAgentConfigMigrationItem[],
  ) => Promise<{ ok: boolean; error?: string; data?: ExternalAgentConfigImportResponse }>
  dockerGatewayCheck: () => Promise<{ installed: boolean; version?: string; error?: string }>
  dockerGatewayFix: (opts?: { port?: number }) => Promise<{
    ok: boolean
    error?: string
    converted?: string[]
    gatewayPort?: number
  }>
  dockerGatewayStatus: () => Promise<{
    running: boolean
    port: number | null
    pid: number | null
    profile: string | null
  }>
  dockerGatewayStop: () => Promise<{ ok: boolean; error?: string }>
  onMcpStatus: (handler: (event: AgentMcpStatusEvent) => void) => () => void
  getProviders: () => Promise<{
    ok: boolean
    error?: string
    builtins?: CodexProviderRecord[]
    custom?: CodexProviderRecord[]
    activeId?: string
    apiKeys?: Record<string, string>
  }>
  setActiveProvider: (id: string) => Promise<CodexProviderMutationResponse>
  setProviderApiKey: (id: string, key: string) => Promise<CodexProviderMutationResponse>
  addCustomProvider: (
    input: CodexCustomProviderInput,
  ) => Promise<{ ok: boolean; error?: string; provider?: CodexProviderRecord }>
  updateCustomProvider: (
    id: string,
    patch: Partial<CodexCustomProviderInput>,
  ) => Promise<CodexProviderMutationResponse>
  removeCustomProvider: (id: string) => Promise<CodexProviderMutationResponse>
}

/**
 * 渲染层看到的桥。**每个方法都是可选的**,这不是偷懒:热更新会让 preload 与
 * 渲染包版本错位(工作台 store 里早有这条注释),jsdom 测试也只挂需要的几个
 * mock。所以调用点必须一律 `?.`,类型如实反映这一点,少一个可选就会把真实的
 * 缺失伪装成必然存在。
 */
export type AgentApiBridge = Partial<AgentApi>
