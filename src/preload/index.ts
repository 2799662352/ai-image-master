// src/preload/index.ts - 预加载脚本，暴露安全的 API 给渲染进程
//
// V16.3 安全审计通过:
// ✅ 使用 contextBridge.exposeInMainWorld 暴露 API
// ✅ 不直接暴露 ipcRenderer，只暴露特定方法
// ✅ 使用 IPC_CHANNELS 常量集中管理通道名
// ✅ safeOn 函数验证通道是否在允许列表中
// ✅ 所有方法使用 ipcRenderer.invoke 进行请求-响应通信
//
import { ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import type {
  SplitSubmitPayload,
  SplitConfig,
  SplitProgressEvent,
  SplitFinishedEvent,
  SplitFailedEvent,
  CredentialState,
} from '../types/storyboardSplit'
import type {
  EraseSubmitPayload,
  EraseConfig,
  EraseProgressEvent,
  EraseFinishedEvent,
  EraseFailedEvent,
  EraseProbeResult,
} from '../types/smartErase'
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
  AgentThreadSummary,
  AgentToolRequest,
  AgentToolResponse,
  ImageTaskUpdate,
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
} from '../types/agent'
import type {
  MarketplaceAdoptExistingResult,
  MarketplaceFetchCatalogResult,
  MarketplaceGetPathsResult,
  MarketplaceInstallResult,
  MarketplaceListInstalledResult,
  MarketplaceUninstallResult,
  PluginFetchCatalogResult,
  PluginInstallResult,
  PluginListInstalledResult,
  PluginUninstallResult,
} from '../types/marketplace'
import type {
  PortraitOverlayMutation,
  PortraitOverlayState,
  SeedanceAssetCapacity,
  SeedanceAssetDeleteResult,
  SeedanceAssetImportInput,
  SeedanceAssetImportResult,
  SeedanceAssetListQuery,
  SeedanceAssetListResult,
  SeedanceKeyState,
  SeedanceRegion,
  SeedanceTaskUpdate,
} from '../types/seedance'
import type {
  VideoWorkbenchSubmitPayload,
  VideoWorkbenchSubmitResult,
} from '../types/videoWorkbench'
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
} from '../types/codexPlugins'
import type { GoalRpcResult, ThreadGoal, ThreadGoalStatus } from '../types/codexGoals'

// ==================== IPC 通道常量 ====================
// 集中管理所有 IPC 通道，便于类型检查和维护

const IPC_CHANNELS = {
  // 存储相关
  STORAGE: {
    SAVE_IMAGE: 'save-image',
    READ_IMAGE: 'read-image',
    DELETE_IMAGE: 'delete-image',
    GET_INFO: 'get-storage-info',
    SELECT_PATH: 'select-save-path',
    EXPORT_IMAGE: 'export-image',
    OPEN_PATH: 'open-path'
  },
  // 历史记录相关
  HISTORY: {
    LOAD: 'load-history',
    SAVE: 'save-history'
  },
  // 页面状态相关
  PAGE_STATE: {
    SAVE: 'save-page-state',
    LOAD: 'load-page-state',
    CLEAR: 'clear-page-state',
    CLEAR_ALL: 'clear-all-page-states',
    GET_IDS: 'get-saved-page-ids'
  },
  // 缓存相关
  CACHE: {
    CLEAR_WEB: 'clear-web-cache',
    GET_SIZE: 'get-cache-size'
  },
  // 模板相关
  TEMPLATE: {
    SAVE: 'save-template',
    SAVE_OVERRIDE: 'save-template-override',
    LOAD_CUSTOM: 'load-custom-templates',
    LOAD_OVERRIDES: 'load-template-overrides',
    DELETE: 'delete-template',
    RESET_OVERRIDE: 'reset-template-override',
    EXPORT: 'export-templates',
    IMPORT: 'import-templates'
  },
  // 图库相关
  GALLERY: {
    SAVE: 'save-custom-gallery',
    LOAD: 'load-custom-gallery',
    DELETE_IMAGE: 'delete-custom-gallery-image',
    ADD_IMAGE: 'add-custom-gallery-image',
    GET_PATH: 'get-custom-gallery-path'
  },
  // 更新相关
  UPDATE: {
    CHECK: 'check-for-update',
    DOWNLOAD: 'download-update',
    INSTALL: 'install-update',
    GET_VERSION: 'get-app-version'
  },
  // 更新事件通道
  UPDATE_EVENTS: [
    'updater:checking-for-update',
    'updater:update-available',
    'updater:update-not-available',
    'updater:download-progress',
    'updater:update-downloaded',
    'updater:update-error'
  ],
  // 系统主题事件
  SYSTEM: {
    NATIVE_THEME_CHANGED: 'native-theme-changed'
  },
  // AI Skills
  SKILLS: {
    LOAD_ALL: 'load-skills',
    SAVE: 'save-skill',
    OPEN_FOLDER: 'open-skills-folder',
  },
  // Skill Marketplace (catalog hosted on Tencent COS, see
  // scripts/upload-skills-to-cos.mjs + src/main/marketplace/)
  MARKETPLACE: {
    FETCH_CATALOG: 'marketplace:fetch-catalog',
    INSTALL: 'marketplace:install',
    UNINSTALL: 'marketplace:uninstall',
    LIST_INSTALLED: 'marketplace:list-installed',
    ADOPT_EXISTING: 'marketplace:adopt-existing',
    GET_PATHS: 'marketplace:get-paths',
  },
  // Plugin Marketplace (one-click skill bundles, see
  // scripts/upload-plugins-to-cos.mjs + src/main/marketplace/)
  PLUGIN_MARKETPLACE: {
    FETCH_CATALOG: 'plugin-marketplace:fetch-catalog',
    INSTALL: 'plugin-marketplace:install',
    UNINSTALL: 'plugin-marketplace:uninstall',
    LIST_INSTALLED: 'plugin-marketplace:list-installed',
  },
  // 宫格拆图
  STORYBOARD_SPLIT: {
    SUBMIT: 'storyboard-split:submit',
    CANCEL: 'storyboard-split:cancel',
    GET_CONFIG: 'storyboard-split:get-config',
    SET_CREDENTIALS: 'storyboard-split:set-credentials',
    SET_DEFAULTS: 'storyboard-split:set-defaults',
    DELETE_REMOTE: 'storyboard-split:delete-remote',
  },
  STORYBOARD_SPLIT_EVENTS: [
    'storyboard-split:progress',
    'storyboard-split:finished',
    'storyboard-split:failed',
  ] as const,
  // 智能去字幕
  SMART_ERASE: {
    SUBMIT: 'smart-erase:submit',
    CANCEL: 'smart-erase:cancel',
    GET_CONFIG: 'smart-erase:get-config',
    SET_CREDENTIALS: 'smart-erase:set-credentials',
    DELETE_REMOTE: 'smart-erase:delete-remote',
    DOWNLOAD_FILE: 'smart-erase:download-file',
  },
  SMART_ERASE_EVENTS: [
    'erase:progress',
    'erase:finished',
    'erase:failed',
  ] as const,
  // Codex Agent
  AGENT: {
    SEND_MESSAGE: 'agent:send-message',
    STEER: 'agent:turn-steer',
    CANCEL: 'agent:cancel',
    LIST_THREADS: 'agent:list-threads',
    LOAD_THREAD: 'agent:load-thread',
    UPLOAD_ATTACHMENTS: 'agent:upload-attachments',
    TOOL_RESPONSE: 'agent:tool-response',
    IMAGE_TASK_UPDATE: 'image:task-update',
    CANVAS_SUBMIT_EDIT_REQUEST: 'canvas:submit-edit-request',
    CANVAS_EDIT_QUEUE_STATUS: 'canvas:edit-queue-status',
    SET_API_KEY: 'agent:set-api-key',
    TEST_CONNECTION: 'agent:test-connection',
    GET_SESSION_STATUS: 'agent:get-session-status',
    SET_SESSION_CONFIG: 'agent:set-session-config',
    RESET_SESSION_CONFIG: 'agent:reset-session-config',
    SET_ALLOWED_ROOTS: 'agent:set-allowed-roots',
    RESPOND_APPROVAL: 'agent:respond-approval',
    GET_MCP_SUMMARY: 'agent:get-mcp-summary',
    GET_SKILLS_SUMMARY: 'agent:get-skills-summary',
    LIST_SKILLS: 'agent:list-skills',
    GET_SKILL_DETAIL: 'agent:get-skill-detail',
    SAVE_SKILL: 'agent:save-skill',
    DELETE_SKILL: 'agent:delete-skill',
    OPEN_SKILLS_ROOT: 'agent:open-skills-root',
    GET_WORKSPACE_LOGS: 'agent:get-workspace-logs',
    RESTART_CODEX: 'agent:restart-codex',
    LIST_CODEX_THREADS: 'agent:list-codex-threads',
    READ_CODEX_THREAD: 'agent:read-codex-thread',
    FORK_CODEX_THREAD: 'agent:fork-codex-thread',
    ARCHIVE_CODEX_THREAD: 'agent:archive-codex-thread',
    UNARCHIVE_CODEX_THREAD: 'agent:unarchive-codex-thread',
    CODEX_DOCTOR: 'agent:codex-doctor',
    MCP_LIST_SERVERS: 'agent:mcp-list-servers',
    MCP_BATCH_WRITE: 'agent:mcp-batch-write',
    MCP_WRITE_VALUE: 'agent:mcp-write-value',
    MCP_RELOAD: 'agent:mcp-reload',
    MCP_OAUTH_LOGIN: 'agent:mcp-oauth-login',
    MCP_READ_CONFIG: 'agent:mcp-read-config',
    MCP_READ_RAW_CONFIG: 'agent:mcp-read-raw-config',
    MCP_STATUS_SNAPSHOT: 'agent:mcp-status-snapshot',
    GOAL_SET: 'agent:goal-set',
    GOAL_GET: 'agent:goal-get',
    GOAL_CLEAR: 'agent:goal-clear',
    COMPACT_START: 'agent:compact-start',
    COLLABORATION_CAPABILITIES: 'agent:collaboration-capabilities',
    COLLABORATION_UPDATE: 'agent:collaboration-update',
    MODEL_SETTINGS_CATALOG: 'agent:model-settings-catalog',
    MODEL_CONTEXT_GET: 'agent:model-context-get',
    MODEL_CONTEXT_APPLY: 'agent:model-context-apply',
    MODEL_SELECTION_APPLY: 'agent:model-selection-apply',
    MODEL_SELECTION_RECOVER: 'agent:model-selection-recover',
    PLUGIN_LIST: 'agent:plugin-list',
    PLUGIN_INSTALLED: 'agent:plugin-installed',
    PLUGIN_READ: 'agent:plugin-read',
    PLUGIN_INSTALL: 'agent:plugin-install',
    PLUGIN_UNINSTALL: 'agent:plugin-uninstall',
    MARKETPLACE_ADD: 'agent:marketplace-add',
    MARKETPLACE_REMOVE: 'agent:marketplace-remove',
    MARKETPLACE_UPGRADE: 'agent:marketplace-upgrade',
    APPS_LIST: 'agent:apps-list',
    EXT_AGENT_DETECT: 'agent:ext-agent-detect',
    EXT_AGENT_IMPORT: 'agent:ext-agent-import',
    DOCKER_GW_CHECK: 'agent:docker-gw-check',
    DOCKER_GW_FIX: 'agent:docker-gw-fix',
    DOCKER_GW_STATUS: 'agent:docker-gw-status',
    DOCKER_GW_STOP: 'agent:docker-gw-stop',
    OPEN_THREAD: 'agent:open-thread',
    RENAME_THREAD: 'agent:rename-thread',
    DELETE_THREAD: 'agent:delete-thread',
    GET_PROVIDERS: 'agent:get-providers',
    SET_ACTIVE_PROVIDER: 'agent:set-active-provider',
    SET_PROVIDER_API_KEY: 'agent:set-provider-api-key',
    GET_GATEWAYS: 'agent:get-gateways',
    SET_ACTIVE_GATEWAY: 'agent:set-active-gateway',
    SET_GATEWAY_API_KEY: 'agent:set-gateway-api-key',
    ADD_CUSTOM_PROVIDER: 'agent:add-custom-provider',
    UPDATE_CUSTOM_PROVIDER: 'agent:update-custom-provider',
    REMOVE_CUSTOM_PROVIDER: 'agent:remove-custom-provider',
  },
  AGENT_EVENTS: [
    'agent:event',
    'agent:tool-request',
    'agent:approval-request',
  ] as const,
  AGENT_MCP_EVENTS: ['agent:mcp-status'] as const,
  AGENT_GOAL_EVENTS: ['agent:goal'] as const,
  // Shell helpers (clipboard / save dialog)
  SHELL: {
    COPY_IMAGE: 'shell:copy-image',
    SAVE_AS: 'shell:save-as',
    SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
    OPEN_EXTERNAL: 'shell:open-external',
  },
  FILE_EXPLORER: {
    READ_TEXT: 'fs:read-text',
    READ_BINARY: 'fs:read-binary',
    WRITE_TEXT: 'fs:write-text',
    LIST_DIR: 'fs:list-dir',
    STAT: 'fs:stat',
    TRASH: 'fs:trash',
    RENAME: 'fs:rename',
    CREATE_FILE: 'fs:create-file',
    CREATE_FOLDER: 'fs:create-folder',
    COPY: 'fs:copy',
    IMPORT_EXTERNAL: 'fs:import-external',
    MOVE: 'fs:move',
    OPEN_IN_TERMINAL: 'fs:open-in-terminal',
    PICK_FOLDER: 'workspace:pick-folder',
    WATCH_START: 'fs:watch-start',
    WATCH_STOP: 'fs:watch-stop',
    WATCH_EVENT: 'fs:watch-event',
  },
  ATTACHMENTS: {
    LIST_TREE: 'attachments:list-tree',
    CHANGED: 'attachments:changed',
    READ_THUMB: 'attachments:read-thumb',
    // Persist a renderer-produced image (e.g. a codex `generate_image` result)
    // into the watched uploads dir so it shows in the ATTACHMENTS file panel.
    SAVE: 'attachments:save',
    // Same as SAVE but the renderer hands a remote http(s) URL instead of bytes.
    // The MAIN process downloads it (Node fetch → no browser CORS) and ingests,
    // so URL-returning image/video channels (whose COS/OSS links omit
    // Access-Control-Allow-Origin) can still be saved to local paths.
    SAVE_FROM_URL: 'attachments:save-from-url',
    // PR-A hot-path: resized JPEG thumbnails. See main/file-explorer/mediaThumbIpc.ts
    // for the size/security envelope. Renderer calls this by default; falls
    // through to READ_THUMB only when `useResolvedMediaSrc(..., { fullFidelity: true })`.
    MEDIA_THUMB: 'media:thumb',
    // Generate-once + persist a video bubble's still frame as a static COS
    // object (so chat never re-runs the billable 数据万象 snapshot per render).
    // See main/file-explorer/videoPosterIpc.ts.
    ENSURE_VIDEO_POSTER: 'media:ensure-video-poster',
  },
  // Restorable tldraw canvas checkpoints (gap-analysis §8/§9). The renderer
  // serialises with getSnapshot → JSON; these channels write/read/list that
  // JSON on disk (attachments:save is image/video only).
  CANVAS: {
    SAVE_CHECKPOINT: 'canvas:save-checkpoint',
    READ_CHECKPOINT: 'canvas:read-checkpoint',
    LIST_CHECKPOINTS: 'canvas:list-checkpoints',
  },
} as const

export interface CanvasCheckpointMeta {
  checkpointId: string
  name: string
  createdAt: string
  shapeCount: number
  path: string
}

// ==================== 类型定义 ====================

export interface IpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface SaveImageResponse {
  success: boolean
  path?: string
  error?: string
}

export interface StorageInfo {
  imageCount: number
  totalSize: number
  storagePath: string
  isElectron?: boolean
}

export interface AddGalleryImageData {
  id: string
  name: string
  sourcePath: string
}

export interface AddGalleryImageResponse {
  success: boolean
  filename?: string
  path?: string
  error?: string
}

export interface ExportTemplatesResponse {
  success: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export interface ImportTemplatesResponse {
  success: boolean
  imported?: { templates: number; overrides: number }
  canceled?: boolean
  error?: string
}

export type FileExplorerWatchEvent = {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
  path: string
  mtime?: number
}

export type FileExplorerNode = {
  path: string
  name: string
  kind: 'file' | 'dir'
  source: 'workspace' | 'attachments'
  childrenLoaded: false
}

export type FileExplorerStat =
  | { ok: true; size: number; mime: string; mtime: number }
  | { ok: false; reason: string }

/**
 * Renderer-side mirror of `ProviderPreset` from
 * `src/main/agent/codexProviders.ts`. Kept in sync manually because preload is
 * a sandboxed module that can't import main-process files at type-check time.
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
  isCustom?: boolean
}

export interface CodexCustomProviderInput {
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

export interface ElectronAPI {
  isElectron: boolean
  // AI Skills
  loadSkills: () => Promise<Record<string, string>>
  saveSkill: (skillName: string, content: string) => Promise<IpcResponse>
  openSkillsFolder: () => Promise<IpcResponse<{ path: string }>>
  // Skill Marketplace
  marketplace: {
    fetchCatalog: (force?: boolean) => Promise<MarketplaceFetchCatalogResult>
    install: (skillName: string) => Promise<MarketplaceInstallResult>
    uninstall: (skillName: string) => Promise<MarketplaceUninstallResult>
    listInstalled: () => Promise<MarketplaceListInstalledResult>
    adoptExisting: () => Promise<MarketplaceAdoptExistingResult>
    getPaths: () => Promise<MarketplaceGetPathsResult>
  }
  // Plugin Marketplace (one-click skill bundles)
  pluginMarketplace: {
    fetchCatalog: (force?: boolean) => Promise<PluginFetchCatalogResult>
    install: (pluginName: string) => Promise<PluginInstallResult>
    uninstall: (pluginName: string) => Promise<PluginUninstallResult>
    listInstalled: () => Promise<PluginListInstalledResult>
  }
  // Codex Agent
  agent: {
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
    getCanvasEditQueueStatus: () => Promise<import('../types/canvas').EditRequestQueueStatus>
    respondApproval: (response: CodexApprovalResponse) => Promise<AgentApiResult>
    setApiKey: (key: string) => Promise<AgentApiResult>
    testConnection: () => Promise<AgentApiResult>
    getSessionStatus: () => Promise<CodexSessionStatus>
    setSessionConfig: (
      patch: Partial<CodexSessionConfig>,
      options?: { persist?: boolean },
    ) => Promise<CodexSessionStatus>
    resetSessionConfig: () => Promise<CodexSessionStatus>
    getCollaborationCapabilities: (
      model: string,
    ) => Promise<AgentCollaborationCapabilitiesResult>
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
    listCodexThreads: (params?: { archived?: boolean; searchTerm?: string }) => Promise<CodexThreadSummary[]>
    readCodexThread: (threadId: string) => Promise<CodexThreadDetail>
    forkCodexThread: (threadId: string) => Promise<CodexThreadSummary>
    archiveCodexThread: (threadId: string) => Promise<AgentApiResult>
    unarchiveCodexThread: (threadId: string) => Promise<{ ok: boolean; error?: string; thread?: CodexThreadSummary }>
    codexDoctor: () => Promise<{ ok: boolean; error?: string; report?: DoctorReport }>
    listMcpServersRpc: (params?: unknown) => Promise<{ ok: boolean; error?: string; data?: unknown }>
    batchWriteConfig: (edits: unknown[], reload?: boolean) => Promise<{ ok: boolean; error?: string }>
    writeConfigValue: (keyPath: string, value: unknown) => Promise<{ ok: boolean; error?: string }>
    reloadMcpServers: () => Promise<{ ok: boolean; error?: string }>
    mcpOAuthLogin: (name: string) => Promise<{ ok: boolean; error?: string; authorization_url?: string }>
    readConfig: () => Promise<{ ok: boolean; error?: string; config?: unknown }>
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
    onGoal: (handler: (event: any) => void) => () => void
    compactThread: (threadId: string) => Promise<GoalRpcResult<{ started: boolean }>>
    // Codex native plugin / marketplace / apps / external-agent-import (≥0.140)
    listPlugins: (params?: PluginListParams) => Promise<{ ok: boolean; error?: string; data?: PluginListResponse }>
    listInstalledPlugins: (params?: PluginInstalledParams) => Promise<{ ok: boolean; error?: string; data?: PluginInstalledResponse }>
    readPlugin: (params: PluginReadParams) => Promise<{ ok: boolean; error?: string; data?: PluginReadResponse }>
    installPlugin: (params: PluginInstallParams) => Promise<{ ok: boolean; error?: string; data?: PluginInstallResponse }>
    uninstallPlugin: (pluginId: string) => Promise<{ ok: boolean; error?: string }>
    addMarketplace: (params: MarketplaceAddParams) => Promise<{ ok: boolean; error?: string; data?: MarketplaceAddResponse }>
    removeMarketplace: (marketplaceName: string) => Promise<{ ok: boolean; error?: string; data?: MarketplaceRemoveResponse }>
    upgradeMarketplaces: (marketplaceName?: string) => Promise<{ ok: boolean; error?: string; data?: MarketplaceUpgradeResponse }>
    listApps: (params?: AppsListParams) => Promise<{ ok: boolean; error?: string; data?: AppsListResponse }>
    detectExternalAgentConfig: (params?: ExternalAgentConfigDetectParams) => Promise<{ ok: boolean; error?: string; data?: ExternalAgentConfigDetectResponse }>
    importExternalAgentConfig: (migrationItems: ExternalAgentConfigMigrationItem[]) => Promise<{ ok: boolean; error?: string; data?: ExternalAgentConfigImportResponse }>
    dockerGatewayCheck: () => Promise<{ installed: boolean; version?: string; error?: string }>
    dockerGatewayFix: (opts?: { port?: number }) => Promise<{
      ok: boolean
      error?: string
      converted?: string[]
      gatewayPort?: number
    }>
    dockerGatewayStatus: () => Promise<{ running: boolean; port: number | null; pid: number | null; profile: string | null }>
    dockerGatewayStop: () => Promise<{ ok: boolean; error?: string }>
    onMcpStatus: (handler: (event: any) => void) => () => void
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
  // Shell helpers (clipboard / save dialog)
  shell: {
    copyImage: (uri: string) => Promise<IpcResponse>
    saveAs: (uri: string, suggestedName: string) => Promise<IpcResponse>
    showItemInFolder: (p: string) => Promise<void>
    openExternal: (url: string) => Promise<IpcResponse>
  }
  // 音频作品库存储(AudioPage):方案 A 本地文件 + 方案 B COS 桶备份
  audioHistory: {
    save: (base64: string, format: string) => Promise<
      { success: true; filePath: string } | { success: false; error: string }
    >
    read: (filePath: string) => Promise<
      { success: true; base64: string } | { success: false; error: string }
    >
    delete: (filePath: string) => Promise<{ success: true } | { success: false; error: string }>
    uploadCos: (base64: string, format: string) => Promise<
      { success: true; url: string; key: string } | { success: false; error: string }
    >
  }
  // Tencent COS uploads for renderer-side flows (image history, etc.).
  // Routed through the main process so the COS SecretId/SecretKey never
  // leak into renderer-land. Bucket selection is determined by the IPC
  // handler — `uploadImageHistory` always targets the image-master bucket
  // (separate from storyboardSplit/smartErase).
  cos: {
    uploadImageHistory: (
      base64: string,
      mimeType: string,
      metadata?: Record<string, unknown>,
    ) => Promise<
      | { success: true; url: string; key: string }
      | { success: false; error: string }
    >
    /**
     * 字节版 fire-and-forget 入队 (P0 闪退修复 2026-07-09)。
     * 渲染端传 ArrayBuffer(结构化克隆原始字节), 避免 40MB 级 base64
     * 字符串跨 IPC 在两侧 V8 堆各驻留一份。结果走 onUploadResult 事件。
     */
    enqueueUploadBytes: (
      requestId: string,
      bytes: ArrayBuffer,
      mimeType?: string,
      metadata?: Record<string, unknown>,
    ) => Promise<{ queued: true } | { queued: false; error: string }>
  }
  // Seedance 视频生成（codex `generate_video` 工具）。Key 走主进程
  // safeStorage，渲染端只见 masked 状态；任务进度经 `seedance:task-update`
  // 推送驱动聊天气泡。
  seedance: {
    getConfig: () => Promise<SeedanceKeyState>
    setConfig: (config: {
      apiKey?: string
      apiSecret?: string
      region?: SeedanceRegion
    }) => Promise<SeedanceKeyState>
    onTaskUpdate: (cb: (update: SeedanceTaskUpdate) => void) => () => void
    /** 素材库（人像库）：列表 / 导入 / 额度 / 批量删除。需要 API Secret。 */
    listAssets: (query: SeedanceAssetListQuery) => Promise<SeedanceAssetListResult>
    importAsset: (input: SeedanceAssetImportInput) => Promise<SeedanceAssetImportResult>
    getAssetCapacity: () => Promise<SeedanceAssetCapacity>
    deleteAssets: (assetIds: string[]) => Promise<SeedanceAssetDeleteResult>
    /** 人像库本地叠加层（改名/分组/隐藏）：主进程单一真相源，与 MCP agent 共享。 */
    getOverlay: () => Promise<PortraitOverlayState>
    mutateOverlay: (mutation: PortraitOverlayMutation) => Promise<PortraitOverlayState>
    onOverlayChanged: (cb: (state: PortraitOverlayState) => void) => () => void
  }
  // 「生成视频」工作台：提交复用 Seedance 生成链路（buildContent → 提交 →
  // 后台轮询 → 本地落盘 + COS），进度经 seedance.onTaskUpdate 回流。
  videoWorkbench: {
    submit: (payload: VideoWorkbenchSubmitPayload) => Promise<VideoWorkbenchSubmitResult>
  }
  fs: {
    readText: (p: string) => Promise<{ content: string; mtime: number }>
    readBinary: (p: string) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }>
    writeText: (p: string, content: string) => Promise<{ mtime: number }>
    listDir: (p: string) => Promise<FileExplorerNode[]>
    stat: (p: string) => Promise<FileExplorerStat>
    trash: (p: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    rename: (oldPath: string, newName: string) => Promise<{ ok: true; newPath: string } | { ok: false; reason: string }>
    createFile: (parentDir: string, name: string) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    createFolder: (parentDir: string, name: string) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    copy: (sources: string[], destDir: string) => Promise<{ ok: true; written: string[] } | { ok: false; reason: string }>
    importExternal: (sources: string[], destDir: string) => Promise<
      { ok: true; written: string[] } | { ok: false; reason: string; written?: string[] }
    >
    move: (sources: string[], destDir: string) => Promise<{ ok: true; written: string[] } | { ok: false; reason: string }>
    openInTerminal: (p: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    pickFolder: () => Promise<string | null>
    watchStart: (p: string) => Promise<void>
    watchStop: (p: string) => Promise<void>
    onWatchEvent: (cb: (e: FileExplorerWatchEvent) => void) => () => void
  }
  attachments: {
    listTree: () => Promise<FileExplorerNode[]>
    onChanged: (cb: () => void) => () => void
    /**
     * Read an attachment file's bytes for thumbnail/lightbox rendering.
     * Unlike `fs.readBinary` this channel has no workspace allowed-roots
     * gate — instead it enforces a mime+size whitelist (image/video/audio,
     * ≤100 MB). See main/file-explorer/attachmentsIpc.ts for the rationale.
     */
    readThumb: (
      p: string,
    ) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }>
    /**
     * Resized-JPEG thumbnail hot path (PR-A of fix-codex-chat-image-attachment-lag).
     * Returns a small (~5–30 KB) JPEG sized so the longest edge is `size`
     * (default 256). SVGs pass through unchanged; videos are not supported
     * yet and return `{ ok: false; reason: 'video thumbnail not yet supported' }`
     * so the caller can fall back to `readThumb` for fullFidelity rendering.
     */
    readMediaThumb: (args: {
      path: string
      size?: number
    }) => Promise<
      | { ok: true; base64: string; mime: string; width?: number; height?: number }
      | { ok: false; reason: string }
    >
    /**
     * Generate-once + persist a COS video's still frame as a static sibling
     * object (`<videoKey>.poster.jpg`) and return its URL. The billable 数据万象
     * snapshot runs at most once per video (guarded by a COS HEAD check); every
     * later view references the plain poster object (no CI processing → no
     * recurring billing). No-op `{ ok:false }` for non-COS / local videos.
     */
    ensureVideoPoster: (
      videoUrl: string,
    ) => Promise<
      | { ok: true; posterUrl: string; generated: boolean }
      | { ok: false; reason: string }
    >
    /**
     * Persist a renderer-produced image into the agent uploads dir (the dir the
     * ATTACHMENTS panel watches), so codex-generated images appear there. The
     * bytes are sent as base64; the main side content-addresses + size-caps via
     * AttachmentService, then broadcasts `attachments:changed`.
     */
    save: (args: {
      threadId: string
      name: string
      mime: string
      base64: string
    }) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    /**
     * Persist a remote http(s) image/video into the agent uploads dir by
     * downloading it in the MAIN process. CORS is a browser concept, so this
     * succeeds for presigned COS/OSS result URLs that block a renderer `fetch`.
     * The detected Content-Type drives the final extension/mime.
     */
    saveFromUrl: (args: {
      threadId: string
      name: string
      url: string
    }) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  }
  /**
   * Restorable canvas checkpoints (gap-analysis §8/§9). The renderer serialises
   * the live tldraw editor with `getSnapshot(editor.store)` and hands the JSON
   * string here to persist; `readCheckpoint` returns that JSON for `loadSnapshot`
   * to restore. Separate from `attachments` because snapshots are JSON, not media.
   */
  canvas: {
    saveCheckpoint: (args: {
      name?: string
      snapshotJson: string
      shapeCount?: number
    }) => Promise<{ ok: true; checkpointId: string; path: string } | { ok: false; reason: string }>
    readCheckpoint: (
      args: { checkpointId: string },
    ) => Promise<{ ok: true; checkpointId: string; json: string } | { ok: false; reason: string }>
    listCheckpoints: () => Promise<CanvasCheckpointMeta[]>
  }
  // 图片存储
  saveImage: (base64Data: string, filename: string) => Promise<SaveImageResponse>
  readImage: (filename: string) => Promise<string | null>
  deleteImage: (filename: string) => Promise<IpcResponse>
  // 历史记录
  saveHistory: (history: any[]) => Promise<IpcResponse>
  loadHistory: () => Promise<any[]>
  // 存储信息
  getStorageInfo: () => Promise<StorageInfo>
  // 文件操作
  selectSavePath: () => Promise<string | null>
  exportImage: (base64Data: string, targetDir: string, filename: string) => Promise<SaveImageResponse>
  openPath: (filePath: string) => Promise<void>
  // 页面状态持久化
  savePageState: (pageId: string, state: any) => Promise<IpcResponse>
  loadPageState: (pageId: string) => Promise<any | null>
  clearPageState: (pageId: string) => Promise<IpcResponse>
  clearAllPageStates: () => Promise<IpcResponse>
  getSavedPageIds: () => Promise<string[]>
  // 缓存清理
  clearWebCache: () => Promise<IpcResponse>
  getCacheSize: () => Promise<{ cacheSize: number }>
  // 模板存储
  saveTemplate: (templateKey: string, templateData: any) => Promise<IpcResponse>
  saveTemplateOverride: (templateKey: string, templateData: any) => Promise<IpcResponse>
  loadCustomTemplates: () => Promise<Record<string, any>>
  loadTemplateOverrides: () => Promise<Record<string, any>>
  deleteTemplate: (templateKey: string) => Promise<IpcResponse>
  resetTemplateOverride: (templateKey: string) => Promise<IpcResponse>
  exportTemplates: () => Promise<ExportTemplatesResponse>
  importTemplates: () => Promise<ImportTemplatesResponse>
  // 自定义图库
  saveCustomGallery: (images: any[]) => Promise<IpcResponse>
  loadCustomGallery: () => Promise<any[]>
  deleteCustomGalleryImage: (imageId: string) => Promise<IpcResponse>
  addCustomGalleryImage: (imageData: AddGalleryImageData) => Promise<AddGalleryImageResponse>
  getCustomGalleryPath: () => Promise<string>
  // 自动更新
  checkForUpdate: () => Promise<IpcResponse>
  downloadUpdate: () => Promise<IpcResponse>
  installUpdate: () => Promise<IpcResponse>
  getAppVersion: () => Promise<string>
  onUpdateEvent: (channel: string, callback: (data: any) => void) => void
  removeUpdateListener: (channel: string) => void
  // 系统主题监听
  onNativeThemeChanged: (callback: (data: { shouldUseDarkColors: boolean; prefersReducedTransparency: boolean }) => void) => void
  removeNativeThemeListener: () => void
  // 宫格拆图
  storyboardSplitSubmit: (payload: SplitSubmitPayload) => Promise<{ success: boolean; error?: string; errorCode?: string }>
  storyboardSplitCancel: (taskId: string) => Promise<{ success: boolean }>
  storyboardSplitGetConfig: () => Promise<{ success: boolean; defaults: SplitConfig; credentials: CredentialState }>
  storyboardSplitSetCredentials: (creds: { secretId: string; secretKey: string; bucket: string; region: string }) => Promise<{ success: boolean }>
  storyboardSplitSetDefaults: (config: SplitConfig) => Promise<{ success: boolean }>
  storyboardSplitDeleteRemote: (cosPaths: string[]) => Promise<{ success: boolean; error?: string }>
  onStoryboardSplitEvent: (callback: (channel: string, data: SplitProgressEvent | SplitFinishedEvent | SplitFailedEvent) => void) => void
  removeStoryboardSplitListeners: () => void
  // 智能去字幕
  smartEraseSubmit: (payload: EraseSubmitPayload) => Promise<{ success: boolean; taskId?: string; posterDataUrl?: string; error?: string; errorCode?: string }>
  smartEraseCancel: (taskId: string) => Promise<{ success: boolean }>
  smartEraseGetConfig: () => Promise<{ success: boolean; defaults: EraseConfig; credentials: { hasCredentials: boolean; secretId?: string; bucket?: string; region?: string } }>
  smartEraseSetCredentials: (creds: { secretId: string; secretKey: string; bucket: string; region: string }) => Promise<{ success: boolean }>
  smartEraseDeleteRemote: (cosPaths: string[]) => Promise<{ success: boolean; error?: string }>
  smartEraseDownloadFile: (url: string, suggestedName: string) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
  onSmartEraseEvent: (callback: (channel: string, data: EraseProgressEvent | EraseFinishedEvent | EraseFailedEvent) => void) => void
  removeSmartEraseListeners: () => void
  // 文件路径访问（合成 File 对象返回 ""，非 File 对象抛异常被吞掉返回 ""）
  getFilePath: (file: File) => string
  // 通用事件监听(更新等事件)。
  // 返回值: unsubscribe 函数 —— 调用即移除自己注册的那个 wrapper,
  // 不影响同 channel 上的其他订阅。旧调用方忽略返回值即可。
  on: (channel: string, callback: (...args: any[]) => void) => () => void
  /**
   * 清空指定 channel 上所有的 listener。语义保留作为"全员退订"用,
   * 但同 channel 上别人的订阅也会被一锅端。
   * 推荐用法: 改用 `on()` 返回的 unsubscribe 函数, 只摘自己那一个。
   */
  off: (channel: string) => void
}

// ==================== IPC 调用辅助函数 ====================

/**
 * 安全的 IPC 调用封装
 * 提供统一的错误处理和日志记录
 */
function safeInvoke<T>(channel: string, ...args: any[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args)
}

/**
 * 安全的事件监听封装
 * 验证通道是否在允许列表中
 */
function safeOn(
  channel: string, 
  callback: (data: any) => void, 
  allowedChannels: readonly string[]
): boolean {
  if (allowedChannels.includes(channel)) {
    ipcRenderer.on(channel, (_event: IpcRendererEvent, data: any) => callback(data))
    return true
  }
  console.warn(`[Preload] 不允许监听的通道: ${channel}`)
  return false
}

function safeOnWithCleanup<T>(
  channel: string,
  callback: (data: T) => void,
  allowedChannels: readonly string[]
): () => void {
  if (!allowedChannels.includes(channel)) {
    console.warn(`[Preload] 不允许监听的通道: ${channel}`)
    return () => {}
  }

  const listener = (_event: IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// ==================== 创建 Electron API ====================

/**
 * 暴露到渲染进程的 API 对象
 * 所有方法都通过 IPC 与主进程通信
 */
const electronAPI: ElectronAPI = {
  isElectron: true,

  // ============ 图片存储 ============
  saveImage: (base64Data: string, filename: string) =>
    safeInvoke<SaveImageResponse>(IPC_CHANNELS.STORAGE.SAVE_IMAGE, { base64Data, filename }),

  readImage: (filename: string) =>
    safeInvoke<string | null>(IPC_CHANNELS.STORAGE.READ_IMAGE, filename),

  deleteImage: (filename: string) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.STORAGE.DELETE_IMAGE, filename),

  // ============ 历史记录 ============
  saveHistory: (history: any[]) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.HISTORY.SAVE, history),

  loadHistory: () =>
    safeInvoke<any[]>(IPC_CHANNELS.HISTORY.LOAD),

  // ============ 存储信息 ============
  getStorageInfo: () =>
    safeInvoke<StorageInfo>(IPC_CHANNELS.STORAGE.GET_INFO),

  // ============ 文件操作 ============
  selectSavePath: () =>
    safeInvoke<string | null>(IPC_CHANNELS.STORAGE.SELECT_PATH),

  exportImage: (base64Data: string, targetDir: string, filename: string) =>
    safeInvoke<SaveImageResponse>(IPC_CHANNELS.STORAGE.EXPORT_IMAGE, { base64Data, targetDir, filename }),

  openPath: (filePath: string) =>
    safeInvoke<void>(IPC_CHANNELS.STORAGE.OPEN_PATH, filePath),

  // ============ 页面状态持久化 ============
  savePageState: (pageId: string, state: any) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.PAGE_STATE.SAVE, pageId, state),

  loadPageState: (pageId: string) =>
    safeInvoke<any | null>(IPC_CHANNELS.PAGE_STATE.LOAD, pageId),

  clearPageState: (pageId: string) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.PAGE_STATE.CLEAR, pageId),

  clearAllPageStates: () =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.PAGE_STATE.CLEAR_ALL),

  getSavedPageIds: () =>
    safeInvoke<string[]>(IPC_CHANNELS.PAGE_STATE.GET_IDS),

  // ============ 缓存清理 ============
  clearWebCache: () =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.CACHE.CLEAR_WEB),

  getCacheSize: () =>
    safeInvoke<{ cacheSize: number }>(IPC_CHANNELS.CACHE.GET_SIZE),

  // ============ 模板存储 ============
  saveTemplate: (templateKey: string, templateData: any) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.TEMPLATE.SAVE, templateKey, templateData),

  saveTemplateOverride: (templateKey: string, templateData: any) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.TEMPLATE.SAVE_OVERRIDE, templateKey, templateData),

  loadCustomTemplates: () =>
    safeInvoke<Record<string, any>>(IPC_CHANNELS.TEMPLATE.LOAD_CUSTOM),

  loadTemplateOverrides: () =>
    safeInvoke<Record<string, any>>(IPC_CHANNELS.TEMPLATE.LOAD_OVERRIDES),

  deleteTemplate: (templateKey: string) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.TEMPLATE.DELETE, templateKey),

  resetTemplateOverride: (templateKey: string) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.TEMPLATE.RESET_OVERRIDE, templateKey),

  exportTemplates: () =>
    safeInvoke<ExportTemplatesResponse>(IPC_CHANNELS.TEMPLATE.EXPORT),

  importTemplates: () =>
    safeInvoke<ImportTemplatesResponse>(IPC_CHANNELS.TEMPLATE.IMPORT),

  // ============ 自定义图库存储 ============
  saveCustomGallery: (images: any[]) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.GALLERY.SAVE, images),

  loadCustomGallery: () =>
    safeInvoke<any[]>(IPC_CHANNELS.GALLERY.LOAD),

  deleteCustomGalleryImage: (imageId: string) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.GALLERY.DELETE_IMAGE, imageId),

  addCustomGalleryImage: (imageData: AddGalleryImageData) =>
    safeInvoke<AddGalleryImageResponse>(IPC_CHANNELS.GALLERY.ADD_IMAGE, imageData),

  getCustomGalleryPath: () =>
    safeInvoke<string>(IPC_CHANNELS.GALLERY.GET_PATH),

  // ============ 自动更新 API ============
  checkForUpdate: () =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.UPDATE.CHECK),

  downloadUpdate: () =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.UPDATE.DOWNLOAD),

  installUpdate: () =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.UPDATE.INSTALL),

  getAppVersion: () =>
    safeInvoke<string>(IPC_CHANNELS.UPDATE.GET_VERSION),

  // ============ 更新事件监听 ============
  onUpdateEvent: (channel: string, callback: (data: any) => void) => {
    safeOn(channel, callback, IPC_CHANNELS.UPDATE_EVENTS)
  },

  removeUpdateListener: (channel: string) => {
    if (IPC_CHANNELS.UPDATE_EVENTS.includes(channel as any)) {
      ipcRenderer.removeAllListeners(channel)
    }
  },

  // ============ AI Skills ============
  loadSkills: () =>
    safeInvoke<Record<string, string>>(IPC_CHANNELS.SKILLS.LOAD_ALL),

  saveSkill: (skillName: string, content: string) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.SKILLS.SAVE, skillName, content),

  openSkillsFolder: () =>
    safeInvoke<IpcResponse<{ path: string }>>(IPC_CHANNELS.SKILLS.OPEN_FOLDER),

  // ============ Skill Marketplace ============
  marketplace: {
    fetchCatalog: (force?: boolean) =>
      safeInvoke<MarketplaceFetchCatalogResult>(
        IPC_CHANNELS.MARKETPLACE.FETCH_CATALOG,
        force === true,
      ),
    install: (skillName: string) =>
      safeInvoke<MarketplaceInstallResult>(IPC_CHANNELS.MARKETPLACE.INSTALL, skillName),
    uninstall: (skillName: string) =>
      safeInvoke<MarketplaceUninstallResult>(IPC_CHANNELS.MARKETPLACE.UNINSTALL, skillName),
    listInstalled: () =>
      safeInvoke<MarketplaceListInstalledResult>(IPC_CHANNELS.MARKETPLACE.LIST_INSTALLED),
    adoptExisting: () =>
      safeInvoke<MarketplaceAdoptExistingResult>(IPC_CHANNELS.MARKETPLACE.ADOPT_EXISTING),
    getPaths: () =>
      safeInvoke<MarketplaceGetPathsResult>(IPC_CHANNELS.MARKETPLACE.GET_PATHS),
  },

  // ============ Plugin Marketplace ============
  pluginMarketplace: {
    fetchCatalog: (force?: boolean) =>
      safeInvoke<PluginFetchCatalogResult>(
        IPC_CHANNELS.PLUGIN_MARKETPLACE.FETCH_CATALOG,
        force === true,
      ),
    install: (pluginName: string) =>
      safeInvoke<PluginInstallResult>(IPC_CHANNELS.PLUGIN_MARKETPLACE.INSTALL, pluginName),
    uninstall: (pluginName: string) =>
      safeInvoke<PluginUninstallResult>(IPC_CHANNELS.PLUGIN_MARKETPLACE.UNINSTALL, pluginName),
    listInstalled: () =>
      safeInvoke<PluginListInstalledResult>(IPC_CHANNELS.PLUGIN_MARKETPLACE.LIST_INSTALLED),
  },

  // ============ Codex Agent ============
  agent: {
    sendMessage: (payload: AgentSendMessagePayload) =>
      safeInvoke<AgentSendMessageResult>(IPC_CHANNELS.AGENT.SEND_MESSAGE, payload),

    steer: (payload: AgentSendMessagePayload) =>
      safeInvoke<AgentSendMessageResult>(IPC_CHANNELS.AGENT.STEER, payload),

    cancel: (payload: AgentCancelPayload) =>
      safeInvoke<IpcResponse>(IPC_CHANNELS.AGENT.CANCEL, payload),

    listThreads: () =>
      safeInvoke<AgentThreadSummary[]>(IPC_CHANNELS.AGENT.LIST_THREADS),

    loadThread: (threadId: string) =>
      safeInvoke<unknown>(IPC_CHANNELS.AGENT.LOAD_THREAD, threadId),

    openThread: (threadId: string) =>
      safeInvoke<unknown>(IPC_CHANNELS.AGENT.OPEN_THREAD, threadId),

    renameThread: (threadId: string, title: string) =>
      safeInvoke<void>(IPC_CHANNELS.AGENT.RENAME_THREAD, threadId, title),

    deleteThread: (threadId: string) =>
      safeInvoke<void>(IPC_CHANNELS.AGENT.DELETE_THREAD, threadId),

    onEvent: (handler: (event: AgentStreamEvent) => void) =>
      safeOnWithCleanup<AgentStreamEvent>(IPC_CHANNELS.AGENT_EVENTS[0], handler, IPC_CHANNELS.AGENT_EVENTS),

    onToolRequest: (handler: (request: AgentToolRequest) => void) =>
      safeOnWithCleanup<AgentToolRequest>(IPC_CHANNELS.AGENT_EVENTS[1], handler, IPC_CHANNELS.AGENT_EVENTS),

    onApprovalRequest: (handler: (request: CodexApprovalRequest) => void) =>
      safeOnWithCleanup<CodexApprovalRequest>(IPC_CHANNELS.AGENT_EVENTS[2], handler, IPC_CHANNELS.AGENT_EVENTS),

    sendToolResponse: (response: AgentToolResponse) => {
      ipcRenderer.send(IPC_CHANNELS.AGENT.TOOL_RESPONSE, response)
    },

    /** Renderer→main: broadcast an async image task's terminal status. */
    sendImageTaskUpdate: (update: ImageTaskUpdate) => {
      ipcRenderer.send(IPC_CHANNELS.AGENT.IMAGE_TASK_UPDATE, update)
    },

    submitCanvasEditRequest: (request: unknown) => {
      ipcRenderer.send(IPC_CHANNELS.AGENT.CANVAS_SUBMIT_EDIT_REQUEST, request)
    },
    getCanvasEditQueueStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT.CANVAS_EDIT_QUEUE_STATUS),

    respondApproval: (response: CodexApprovalResponse) =>
      safeInvoke<AgentApiResult>(IPC_CHANNELS.AGENT.RESPOND_APPROVAL, response),

    setApiKey: (key: string) =>
      safeInvoke<AgentApiResult>(IPC_CHANNELS.AGENT.SET_API_KEY, key),

    testConnection: () =>
      safeInvoke<AgentApiResult>(IPC_CHANNELS.AGENT.TEST_CONNECTION),

    getSessionStatus: () =>
      safeInvoke<CodexSessionStatus>(IPC_CHANNELS.AGENT.GET_SESSION_STATUS),

    setSessionConfig: (patch: Partial<CodexSessionConfig>, options?: { persist?: boolean }) =>
      safeInvoke<CodexSessionStatus>(IPC_CHANNELS.AGENT.SET_SESSION_CONFIG, patch, options),

    resetSessionConfig: () =>
      safeInvoke<CodexSessionStatus>(IPC_CHANNELS.AGENT.RESET_SESSION_CONFIG),

    getCollaborationCapabilities: (model: string) =>
      safeInvoke<AgentCollaborationCapabilitiesResult>(
        IPC_CHANNELS.AGENT.COLLABORATION_CAPABILITIES,
        model,
      ),

    updateCollaborationMode: (payload: AgentCollaborationModeUpdatePayload) =>
      safeInvoke<AgentCollaborationModeUpdateResult>(
        IPC_CHANNELS.AGENT.COLLABORATION_UPDATE,
        payload,
      ),

    getGateways: () =>
      safeInvoke<CodexGatewaySnapshotResponse>(IPC_CHANNELS.AGENT.GET_GATEWAYS),

    setActiveGateway: (id: string) =>
      safeInvoke<CodexProviderMutationResponse>(IPC_CHANNELS.AGENT.SET_ACTIVE_GATEWAY, id),

    setGatewayApiKey: (id: string, key: string) =>
      safeInvoke<CodexProviderMutationResponse>(
        IPC_CHANNELS.AGENT.SET_GATEWAY_API_KEY,
        id,
        key,
      ),

    getModelSettingsCatalog: () =>
      safeInvoke<AgentModelSettingsCatalogResult>(
        IPC_CHANNELS.AGENT.MODEL_SETTINGS_CATALOG,
      ),

    getModelContextConfig: () =>
      safeInvoke<AgentModelContextSnapshotResult>(
        IPC_CHANNELS.AGENT.MODEL_CONTEXT_GET,
      ),

    applyModelContext: (payload: AgentModelContextApplyPayload) =>
      safeInvoke<AgentModelContextApplyResult>(
        IPC_CHANNELS.AGENT.MODEL_CONTEXT_APPLY,
        payload,
      ),

    applyModelSelection: (payload: AgentModelSelectionApplyPayload) =>
      safeInvoke<AgentModelSelectionApplyResult>(
        IPC_CHANNELS.AGENT.MODEL_SELECTION_APPLY,
        payload,
      ),

    recoverModelSelection: () =>
      safeInvoke<AgentModelSelectionRecoveryResult>(
        IPC_CHANNELS.AGENT.MODEL_SELECTION_RECOVER,
      ),

    setAllowedRoots: (roots: string[]) =>
      safeInvoke<string[]>(IPC_CHANNELS.AGENT.SET_ALLOWED_ROOTS, roots),

    getMcpSummary: () =>
      safeInvoke<CodexMcpSummary>(IPC_CHANNELS.AGENT.GET_MCP_SUMMARY),

    getSkillsSummary: () =>
      safeInvoke<CodexSkillsSummary>(IPC_CHANNELS.AGENT.GET_SKILLS_SUMMARY),

    listSkills: () =>
      safeInvoke<CodexSkillListItem[]>(IPC_CHANNELS.AGENT.LIST_SKILLS),

    getSkillDetail: (id: string) =>
      safeInvoke<CodexSkillInput | null>(IPC_CHANNELS.AGENT.GET_SKILL_DETAIL, id),

    saveSkill: (input: CodexSkillInput) =>
      safeInvoke<AgentApiResult & { id?: string }>(IPC_CHANNELS.AGENT.SAVE_SKILL, input),

    deleteSkill: (id: string) =>
      safeInvoke<AgentApiResult>(IPC_CHANNELS.AGENT.DELETE_SKILL, id),

    openSkillsRoot: (scope: 'repo' | 'user' | 'system') =>
      safeInvoke<{ ok: true; path: string } | { ok: false; error: string; path?: string }>(
        IPC_CHANNELS.AGENT.OPEN_SKILLS_ROOT,
        scope,
      ),

    getWorkspaceLogs: (opts?: { limit?: number; sinceIso?: string }) =>
      safeInvoke<CodexAuditLogEntry[]>(IPC_CHANNELS.AGENT.GET_WORKSPACE_LOGS, opts),

    restartCodex: () =>
      safeInvoke<AgentApiResult>(IPC_CHANNELS.AGENT.RESTART_CODEX),

    listCodexThreads: (params?: { archived?: boolean; searchTerm?: string }) =>
      safeInvoke<CodexThreadSummary[]>(IPC_CHANNELS.AGENT.LIST_CODEX_THREADS, params),

    readCodexThread: (threadId: string) =>
      safeInvoke<CodexThreadDetail>(IPC_CHANNELS.AGENT.READ_CODEX_THREAD, threadId),

    forkCodexThread: (threadId: string) =>
      safeInvoke<CodexThreadSummary>(IPC_CHANNELS.AGENT.FORK_CODEX_THREAD, threadId),

    archiveCodexThread: (threadId: string) =>
      safeInvoke<AgentApiResult>(IPC_CHANNELS.AGENT.ARCHIVE_CODEX_THREAD, threadId),

    unarchiveCodexThread: (threadId: string) =>
      safeInvoke<{ ok: boolean; error?: string; thread?: CodexThreadSummary }>(
        IPC_CHANNELS.AGENT.UNARCHIVE_CODEX_THREAD,
        threadId,
      ),

    codexDoctor: () =>
      safeInvoke<{ ok: boolean; error?: string; report?: DoctorReport }>(
        IPC_CHANNELS.AGENT.CODEX_DOCTOR,
      ),

    listMcpServersRpc: (params?: unknown) =>
      safeInvoke<{ ok: boolean; error?: string; data?: unknown }>(IPC_CHANNELS.AGENT.MCP_LIST_SERVERS, params),

    batchWriteConfig: (edits: unknown[], reload?: boolean) =>
      safeInvoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.AGENT.MCP_BATCH_WRITE, edits, reload),

    writeConfigValue: (keyPath: string, value: unknown) =>
      safeInvoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.AGENT.MCP_WRITE_VALUE, keyPath, value),

    reloadMcpServers: () =>
      safeInvoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.AGENT.MCP_RELOAD),

    mcpOAuthLogin: (name: string) =>
      safeInvoke<{ ok: boolean; error?: string; authorization_url?: string }>(IPC_CHANNELS.AGENT.MCP_OAUTH_LOGIN, name),

    readConfig: () =>
      safeInvoke<{ ok: boolean; error?: string; config?: unknown }>(IPC_CHANNELS.AGENT.MCP_READ_CONFIG),

    readRawConfig: () =>
      safeInvoke<{
        ok: boolean
        error?: string
        config?: Record<string, unknown> | null
        raw?: string | null
        parseError?: string
      }>(IPC_CHANNELS.AGENT.MCP_READ_RAW_CONFIG),

    dockerGatewayCheck: () =>
      safeInvoke<{ installed: boolean; version?: string; error?: string }>(IPC_CHANNELS.AGENT.DOCKER_GW_CHECK),

    dockerGatewayFix: (opts?: { port?: number }) =>
      safeInvoke<{ ok: boolean; error?: string; converted?: string[]; gatewayPort?: number }>(
        IPC_CHANNELS.AGENT.DOCKER_GW_FIX,
        opts,
      ),

    dockerGatewayStatus: () =>
      safeInvoke<{ running: boolean; port: number | null; pid: number | null; profile: string | null }>(
        IPC_CHANNELS.AGENT.DOCKER_GW_STATUS,
      ),

    dockerGatewayStop: () =>
      safeInvoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.AGENT.DOCKER_GW_STOP),

    onMcpStatus: (handler: (event: any) => void) =>
      safeOnWithCleanup<any>('agent:mcp-status', handler, IPC_CHANNELS.AGENT_MCP_EVENTS),

    getMcpStatusSnapshot: () =>
      safeInvoke<{
        ok: boolean
        snapshot?: Record<string, { status: string; error: string | null }>
        error?: string
      }>(IPC_CHANNELS.AGENT.MCP_STATUS_SNAPSHOT),

    // ----- Codex native `/goal` (thread/goal/*) -----
    setGoal: (
      threadId: string,
      params: { objective?: string; tokenBudget?: number; status?: ThreadGoalStatus },
    ) => safeInvoke<GoalRpcResult<ThreadGoal>>(IPC_CHANNELS.AGENT.GOAL_SET, threadId, params),

    getGoal: (threadId: string) =>
      safeInvoke<GoalRpcResult<ThreadGoal | null>>(IPC_CHANNELS.AGENT.GOAL_GET, threadId),

    clearGoal: (threadId: string) =>
      safeInvoke<GoalRpcResult<{ cleared: boolean }>>(IPC_CHANNELS.AGENT.GOAL_CLEAR, threadId),

    compactThread: (threadId: string) =>
      safeInvoke<GoalRpcResult<{ started: boolean }>>(IPC_CHANNELS.AGENT.COMPACT_START, threadId),

    onGoal: (handler: (event: any) => void) =>
      safeOnWithCleanup<any>('agent:goal', handler, IPC_CHANNELS.AGENT_GOAL_EVENTS),

    // ----- Codex native plugin / marketplace / apps / external-agent-import (≥0.140) -----
    listPlugins: (params?: PluginListParams) =>
      safeInvoke<{ ok: boolean; error?: string; data?: PluginListResponse }>(IPC_CHANNELS.AGENT.PLUGIN_LIST, params),

    listInstalledPlugins: (params?: PluginInstalledParams) =>
      safeInvoke<{ ok: boolean; error?: string; data?: PluginInstalledResponse }>(IPC_CHANNELS.AGENT.PLUGIN_INSTALLED, params),

    readPlugin: (params: PluginReadParams) =>
      safeInvoke<{ ok: boolean; error?: string; data?: PluginReadResponse }>(IPC_CHANNELS.AGENT.PLUGIN_READ, params),

    installPlugin: (params: PluginInstallParams) =>
      safeInvoke<{ ok: boolean; error?: string; data?: PluginInstallResponse }>(IPC_CHANNELS.AGENT.PLUGIN_INSTALL, params),

    uninstallPlugin: (pluginId: string) =>
      safeInvoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.AGENT.PLUGIN_UNINSTALL, pluginId),

    addMarketplace: (params: MarketplaceAddParams) =>
      safeInvoke<{ ok: boolean; error?: string; data?: MarketplaceAddResponse }>(IPC_CHANNELS.AGENT.MARKETPLACE_ADD, params),

    removeMarketplace: (marketplaceName: string) =>
      safeInvoke<{ ok: boolean; error?: string; data?: MarketplaceRemoveResponse }>(IPC_CHANNELS.AGENT.MARKETPLACE_REMOVE, marketplaceName),

    upgradeMarketplaces: (marketplaceName?: string) =>
      safeInvoke<{ ok: boolean; error?: string; data?: MarketplaceUpgradeResponse }>(IPC_CHANNELS.AGENT.MARKETPLACE_UPGRADE, marketplaceName),

    listApps: (params?: AppsListParams) =>
      safeInvoke<{ ok: boolean; error?: string; data?: AppsListResponse }>(IPC_CHANNELS.AGENT.APPS_LIST, params),

    detectExternalAgentConfig: (params?: ExternalAgentConfigDetectParams) =>
      safeInvoke<{ ok: boolean; error?: string; data?: ExternalAgentConfigDetectResponse }>(IPC_CHANNELS.AGENT.EXT_AGENT_DETECT, params),

    importExternalAgentConfig: (migrationItems: ExternalAgentConfigMigrationItem[]) =>
      safeInvoke<{ ok: boolean; error?: string; data?: ExternalAgentConfigImportResponse }>(IPC_CHANNELS.AGENT.EXT_AGENT_IMPORT, migrationItems),

    // ----- Codex provider management (v4.3+) -----
    getProviders: () =>
      safeInvoke<{
        ok: boolean
        error?: string
        builtins?: CodexProviderRecord[]
        custom?: CodexProviderRecord[]
        activeId?: string
        apiKeys?: Record<string, string>
      }>(IPC_CHANNELS.AGENT.GET_PROVIDERS),

    setActiveProvider: (id: string) =>
      safeInvoke<CodexProviderMutationResponse>(
        IPC_CHANNELS.AGENT.SET_ACTIVE_PROVIDER,
        id,
      ),

    setProviderApiKey: (id: string, key: string) =>
      safeInvoke<CodexProviderMutationResponse>(
        IPC_CHANNELS.AGENT.SET_PROVIDER_API_KEY,
        id,
        key,
      ),

    addCustomProvider: (input: CodexCustomProviderInput) =>
      safeInvoke<{ ok: boolean; error?: string; provider?: CodexProviderRecord }>(
        IPC_CHANNELS.AGENT.ADD_CUSTOM_PROVIDER,
        input,
      ),

    updateCustomProvider: (id: string, patch: Partial<CodexCustomProviderInput>) =>
      safeInvoke<CodexProviderMutationResponse>(
        IPC_CHANNELS.AGENT.UPDATE_CUSTOM_PROVIDER,
        id,
        patch,
      ),

    removeCustomProvider: (id: string) =>
      safeInvoke<CodexProviderMutationResponse>(
        IPC_CHANNELS.AGENT.REMOVE_CUSTOM_PROVIDER,
        id,
      ),
  },

  // ============ Shell helpers (clipboard / save dialog) ============
  shell: {
    copyImage: (uri: string) =>
      safeInvoke<IpcResponse>(IPC_CHANNELS.SHELL.COPY_IMAGE, uri),
    saveAs: (uri: string, suggestedName: string) =>
      safeInvoke<IpcResponse>(IPC_CHANNELS.SHELL.SAVE_AS, { uri, suggestedName }),
    showItemInFolder: (p: string) =>
      safeInvoke<void>(IPC_CHANNELS.SHELL.SHOW_ITEM_IN_FOLDER, p),
    openExternal: (url: string) =>
      safeInvoke<IpcResponse>(IPC_CHANNELS.SHELL.OPEN_EXTERNAL, url),
  },

  // ============ 音频作品库本地文件 (AudioPage) ============
  audioHistory: {
    save: (base64: string, format: string) =>
      safeInvoke<{ success: true; filePath: string } | { success: false; error: string }>(
        'audio-history:save',
        { base64, format },
      ),
    read: (filePath: string) =>
      safeInvoke<{ success: true; base64: string } | { success: false; error: string }>(
        'audio-history:read',
        filePath,
      ),
    delete: (filePath: string) =>
      safeInvoke<{ success: true } | { success: false; error: string }>(
        'audio-history:delete',
        filePath,
      ),
    uploadCos: (base64: string, format: string) =>
      safeInvoke<
        { success: true; url: string; key: string } | { success: false; error: string }
      >('audio-history:upload-cos', { base64, format }),
  },

  // ============ Tencent COS uploads (renderer-facing) ============
  cos: {
    uploadImageHistory: (
      base64: string,
      mimeType: string,
      metadata?: Record<string, unknown>,
    ) =>
      safeInvoke<
        | { success: true; url: string; key: string }
        | { success: false; error: string }
      >('cos:upload-image-history', { base64, mimeType, metadata }),
    uploadImageFromUrl: (
      sourceUrl: string,
      mimeType?: string,
      metadata?: Record<string, unknown>,
    ) =>
      safeInvoke<
        | { success: true; url: string; key: string }
        | { success: false; error: string }
      >('cos:upload-image-from-url', { sourceUrl, mimeType, metadata }),
    /**
     * 真 fire-and-forget: 立即入队, IPC 立刻 resolve。
     * 实际上传完成后, main 进程通过 `onUploadResult` 推回结果。
     * 渲染端 0 个 pending promise, 0 个 .then 微任务。
     */
    enqueueUploadFromUrl: (
      requestId: string,
      sourceUrl: string,
      mimeType?: string,
      metadata?: Record<string, unknown>,
    ) =>
      safeInvoke<{ queued: true } | { queued: false; error: string }>(
        'cos:enqueue-upload-from-url',
        { requestId, sourceUrl, mimeType, metadata },
      ),
    /**
     * 字节版 fire-and-forget 入队 (P0 闪退修复 2026-07-09):
     * ArrayBuffer 结构化克隆是原始字节拷贝, 比 base64 字符串小 25%,
     * 且两侧都不进 V8 字符串堆。上传结果统一走 onUploadResult 事件。
     */
    enqueueUploadBytes: (
      requestId: string,
      bytes: ArrayBuffer,
      mimeType?: string,
      metadata?: Record<string, unknown>,
    ) =>
      safeInvoke<{ queued: true } | { queued: false; error: string }>(
        'cos:enqueue-upload-bytes',
        { requestId, bytes, mimeType, metadata },
      ),
    onUploadResult: (
      cb: (
        result:
          // localPath (2026-07-09): 主进程上传前先把字节落到
          // userData/generated-images 的本地副本路径; 写盘失败时缺省。
          | { requestId: string; success: true; url: string; key: string; localPath?: string }
          | { requestId: string; success: false; error: string; localPath?: string },
      ) => void,
    ) => {
      const handler = (_evt: IpcRendererEvent, data: any): void => cb(data)
      ipcRenderer.on('cos:upload-result', handler)
      return () => ipcRenderer.removeListener('cos:upload-result', handler)
    },
  },

  // ============ Seedance 视频生成 ============
  seedance: {
    getConfig: () => safeInvoke<SeedanceKeyState>('seedance:get-config'),
    setConfig: (config: { apiKey?: string; apiSecret?: string; region?: SeedanceRegion }) =>
      safeInvoke<SeedanceKeyState>('seedance:set-config', config),
    onTaskUpdate: (cb: (update: SeedanceTaskUpdate) => void) => {
      const handler = (_evt: IpcRendererEvent, data: SeedanceTaskUpdate): void => cb(data)
      ipcRenderer.on('seedance:task-update', handler)
      return () => ipcRenderer.removeListener('seedance:task-update', handler)
    },
    listAssets: (query: SeedanceAssetListQuery) =>
      safeInvoke<SeedanceAssetListResult>('seedance:assets-list', query),
    importAsset: (input: SeedanceAssetImportInput) =>
      safeInvoke<SeedanceAssetImportResult>('seedance:assets-import', input),
    getAssetCapacity: () => safeInvoke<SeedanceAssetCapacity>('seedance:assets-capacity'),
    deleteAssets: (assetIds: string[]) =>
      safeInvoke<SeedanceAssetDeleteResult>('seedance:assets-delete', { assetIds }),
    getOverlay: () => safeInvoke<PortraitOverlayState>('seedance:overlay-get'),
    mutateOverlay: (mutation: PortraitOverlayMutation) =>
      safeInvoke<PortraitOverlayState>('seedance:overlay-mutate', mutation),
    onOverlayChanged: (cb: (state: PortraitOverlayState) => void) => {
      const handler = (_evt: IpcRendererEvent, data: PortraitOverlayState): void => cb(data)
      ipcRenderer.on('seedance:overlay-changed', handler)
      return () => ipcRenderer.removeListener('seedance:overlay-changed', handler)
    },
  },

  // ============ 「生成视频」工作台 ============
  videoWorkbench: {
    submit: (payload: VideoWorkbenchSubmitPayload) =>
      safeInvoke<VideoWorkbenchSubmitResult>('video-workbench:submit', payload),
  },

  fs: {
    readText: (p: string) =>
      safeInvoke<{ content: string; mtime: number }>(IPC_CHANNELS.FILE_EXPLORER.READ_TEXT, p),
    readBinary: (p: string) =>
      safeInvoke<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }>(IPC_CHANNELS.FILE_EXPLORER.READ_BINARY, p),
    writeText: (p: string, content: string) =>
      safeInvoke<{ mtime: number }>(IPC_CHANNELS.FILE_EXPLORER.WRITE_TEXT, { path: p, content }),
    listDir: (p: string) =>
      safeInvoke<FileExplorerNode[]>(IPC_CHANNELS.FILE_EXPLORER.LIST_DIR, p),
    stat: (p: string) =>
      safeInvoke<FileExplorerStat>(IPC_CHANNELS.FILE_EXPLORER.STAT, p),
    trash: (p: string) =>
      safeInvoke<{ ok: true } | { ok: false; reason: string }>(IPC_CHANNELS.FILE_EXPLORER.TRASH, p),
    rename: (oldPath: string, newName: string) =>
      safeInvoke<{ ok: true; newPath: string } | { ok: false; reason: string }>(
        IPC_CHANNELS.FILE_EXPLORER.RENAME,
        { oldPath, newName },
      ),
    createFile: (parentDir: string, name: string) =>
      safeInvoke<{ ok: true; path: string } | { ok: false; reason: string }>(
        IPC_CHANNELS.FILE_EXPLORER.CREATE_FILE,
        { parentDir, name },
      ),
    createFolder: (parentDir: string, name: string) =>
      safeInvoke<{ ok: true; path: string } | { ok: false; reason: string }>(
        IPC_CHANNELS.FILE_EXPLORER.CREATE_FOLDER,
        { parentDir, name },
      ),
    copy: (sources: string[], destDir: string) =>
      safeInvoke<{ ok: true; written: string[] } | { ok: false; reason: string }>(
        IPC_CHANNELS.FILE_EXPLORER.COPY,
        { sources, destDir },
      ),
    importExternal: (sources: string[], destDir: string) =>
      safeInvoke<
        { ok: true; written: string[] } | { ok: false; reason: string; written?: string[] }
      >(IPC_CHANNELS.FILE_EXPLORER.IMPORT_EXTERNAL, { sources, destDir }),
    move: (sources: string[], destDir: string) =>
      safeInvoke<{ ok: true; written: string[] } | { ok: false; reason: string }>(
        IPC_CHANNELS.FILE_EXPLORER.MOVE,
        { sources, destDir },
      ),
    openInTerminal: (p: string) =>
      safeInvoke<{ ok: true } | { ok: false; reason: string }>(
        IPC_CHANNELS.FILE_EXPLORER.OPEN_IN_TERMINAL,
        p,
      ),
    pickFolder: () =>
      safeInvoke<string | null>(IPC_CHANNELS.FILE_EXPLORER.PICK_FOLDER),
    watchStart: (p: string) =>
      safeInvoke<void>(IPC_CHANNELS.FILE_EXPLORER.WATCH_START, p),
    watchStop: (p: string) =>
      safeInvoke<void>(IPC_CHANNELS.FILE_EXPLORER.WATCH_STOP, p),
    onWatchEvent: (cb: (e: FileExplorerWatchEvent) => void) => {
      const handler = (_evt: IpcRendererEvent, e: FileExplorerWatchEvent): void => cb(e)
      ipcRenderer.on(IPC_CHANNELS.FILE_EXPLORER.WATCH_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_EXPLORER.WATCH_EVENT, handler)
    },
  },

  attachments: {
    listTree: () =>
      safeInvoke<FileExplorerNode[]>(IPC_CHANNELS.ATTACHMENTS.LIST_TREE),
    onChanged: (cb: () => void) => {
      const handler = (): void => cb()
      ipcRenderer.on(IPC_CHANNELS.ATTACHMENTS.CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.ATTACHMENTS.CHANGED, handler)
    },
    readThumb: (p: string) =>
      safeInvoke<
        { ok: true; base64: string; mime: string } | { ok: false; reason: string }
      >(IPC_CHANNELS.ATTACHMENTS.READ_THUMB, p),
    readMediaThumb: (args: { path: string; size?: number }) =>
      safeInvoke<
        | { ok: true; base64: string; mime: string; width?: number; height?: number }
        | { ok: false; reason: string }
      >(IPC_CHANNELS.ATTACHMENTS.MEDIA_THUMB, args),
    ensureVideoPoster: (videoUrl: string) =>
      safeInvoke<
        | { ok: true; posterUrl: string; generated: boolean }
        | { ok: false; reason: string }
      >(IPC_CHANNELS.ATTACHMENTS.ENSURE_VIDEO_POSTER, videoUrl),
    save: (args: { threadId: string; name: string; mime: string; base64: string }) =>
      safeInvoke<{ ok: true; path: string } | { ok: false; reason: string }>(
        IPC_CHANNELS.ATTACHMENTS.SAVE,
        args,
      ),
    saveFromUrl: (args: { threadId: string; name: string; url: string }) =>
      safeInvoke<{ ok: true; path: string } | { ok: false; reason: string }>(
        IPC_CHANNELS.ATTACHMENTS.SAVE_FROM_URL,
        args,
      ),
  },

  // ============ 画布快照 checkpoint ============
  canvas: {
    saveCheckpoint: (args: { name?: string; snapshotJson: string; shapeCount?: number }) =>
      safeInvoke<{ ok: true; checkpointId: string; path: string } | { ok: false; reason: string }>(
        IPC_CHANNELS.CANVAS.SAVE_CHECKPOINT,
        args,
      ),
    readCheckpoint: (args: { checkpointId: string }) =>
      safeInvoke<{ ok: true; checkpointId: string; json: string } | { ok: false; reason: string }>(
        IPC_CHANNELS.CANVAS.READ_CHECKPOINT,
        args,
      ),
    listCheckpoints: () =>
      safeInvoke<CanvasCheckpointMeta[]>(IPC_CHANNELS.CANVAS.LIST_CHECKPOINTS),
  },

  // ============ 系统主题监听 ============
  onNativeThemeChanged: (callback: (data: { shouldUseDarkColors: boolean; prefersReducedTransparency: boolean }) => void) => {
    ipcRenderer.on(IPC_CHANNELS.SYSTEM.NATIVE_THEME_CHANGED, (_event, data) => callback(data))
  },

  removeNativeThemeListener: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SYSTEM.NATIVE_THEME_CHANGED)
  },

  // ============ 宫格拆图 ============
  storyboardSplitSubmit: (payload: any) =>
    safeInvoke(IPC_CHANNELS.STORYBOARD_SPLIT.SUBMIT, payload),

  storyboardSplitCancel: (taskId: string) =>
    safeInvoke(IPC_CHANNELS.STORYBOARD_SPLIT.CANCEL, { taskId }),

  storyboardSplitGetConfig: () =>
    safeInvoke(IPC_CHANNELS.STORYBOARD_SPLIT.GET_CONFIG),

  storyboardSplitSetCredentials: (creds: any) =>
    safeInvoke(IPC_CHANNELS.STORYBOARD_SPLIT.SET_CREDENTIALS, creds),

  storyboardSplitSetDefaults: (config: any) =>
    safeInvoke(IPC_CHANNELS.STORYBOARD_SPLIT.SET_DEFAULTS, config),

  storyboardSplitDeleteRemote: (cosPaths: string[]) =>
    safeInvoke(IPC_CHANNELS.STORYBOARD_SPLIT.DELETE_REMOTE, cosPaths),

  onStoryboardSplitEvent: (callback: (channel: string, data: any) => void) => {
    for (const ch of IPC_CHANNELS.STORYBOARD_SPLIT_EVENTS) {
      ipcRenderer.on(ch, (_event: IpcRendererEvent, data: any) => callback(ch, data))
    }
  },

  removeStoryboardSplitListeners: () => {
    for (const ch of IPC_CHANNELS.STORYBOARD_SPLIT_EVENTS) {
      ipcRenderer.removeAllListeners(ch)
    }
  },

  // ============ 智能去字幕 ============
  smartEraseSubmit: (payload: EraseSubmitPayload) =>
    safeInvoke(IPC_CHANNELS.SMART_ERASE.SUBMIT, payload),

  smartEraseCancel: (taskId: string) =>
    safeInvoke(IPC_CHANNELS.SMART_ERASE.CANCEL, { taskId }),

  smartEraseGetConfig: () =>
    safeInvoke(IPC_CHANNELS.SMART_ERASE.GET_CONFIG),

  smartEraseSetCredentials: (creds) =>
    safeInvoke(IPC_CHANNELS.SMART_ERASE.SET_CREDENTIALS, creds),

  smartEraseDeleteRemote: (cosPaths: string[]) =>
    safeInvoke(IPC_CHANNELS.SMART_ERASE.DELETE_REMOTE, cosPaths),

  smartEraseDownloadFile: (url: string, suggestedName: string) =>
    safeInvoke(IPC_CHANNELS.SMART_ERASE.DOWNLOAD_FILE, { url, suggestedName }),

  onSmartEraseEvent: (callback) => {
    for (const ch of IPC_CHANNELS.SMART_ERASE_EVENTS) {
      ipcRenderer.on(ch, (_event: IpcRendererEvent, data: any) => callback(ch, data))
    }
  },

  removeSmartEraseListeners: () => {
    for (const ch of IPC_CHANNELS.SMART_ERASE_EVENTS) {
      ipcRenderer.removeAllListeners(ch)
    }
  },

  // 包裹 try/catch 是因为 webUtils.getPathForFile 在传入非 File 对象时会抛异常
  // （而合成 File 只是返回 ""，二者必须区分但对调用方都视作 FILE_PATH_UNAVAILABLE）
  getFilePath: (file: File): string => {
    try { return webUtils.getPathForFile(file) }
    catch { return '' }
  },

  // ============ 通用事件监听 ============
  // 允许的通道：更新事件 + 系统事件
  //
  // 返回值是 unsubscribe 函数。这是和老版本签名(返回 void)的唯一区别 ——
  // 旧调用方仍然兼容(忽略返回值即可); 新调用方可以靠它精确卸载自己挂的那
  // 个 wrapper, 不再需要走 off(channel) 把同通道上别人的订阅一起带走。
  //
  // 为什么这是个 bug 修复: 旧设计里每次 .on(channel, cb) 都会创建一个新的
  // wrapper closure (_event, ...args) => cb(...args), 而 off(channel) 用
  // removeAllListeners 一锅端 —— 同通道两个订阅者其中一个 off, 另一个会
  // 被静默删除。新增 unsubscribe 让单个订阅者可以独立摘掉自己。
  on: (channel: string, callback: (...args: any[]) => void): (() => void) => {
    const allowedChannels = [
      ...IPC_CHANNELS.UPDATE_EVENTS,
      IPC_CHANNELS.SYSTEM.NATIVE_THEME_CHANGED,
      'updater:download-retry',
      ...IPC_CHANNELS.STORYBOARD_SPLIT_EVENTS,
      ...IPC_CHANNELS.SMART_ERASE_EVENTS,
    ]
    if (!allowedChannels.includes(channel)) {
      console.warn(`[Preload] 不允许监听的通道: ${channel}`)
      return () => {}
    }
    const wrapper = (_event: IpcRendererEvent, ...args: any[]): void => callback(...args)
    ipcRenderer.on(channel, wrapper)
    return () => ipcRenderer.removeListener(channel, wrapper)
  },

  off: (channel: string) => {
    const allowedChannels = [
      ...IPC_CHANNELS.UPDATE_EVENTS,
      IPC_CHANNELS.SYSTEM.NATIVE_THEME_CHANGED,
      'updater:download-retry',
      ...IPC_CHANNELS.STORYBOARD_SPLIT_EVENTS,
      ...IPC_CHANNELS.SMART_ERASE_EVENTS,
    ]
    if (allowedChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel)
    }
  }
}

// ==================== 暴露 API 到渲染进程 ====================
// contextIsolation: false — 直接赋值 window（contextBridge 在此模式下不可用）

;(window as any).electronAPI = electronAPI

console.log('Electron preload 已加载，electronAPI 可用')

// ==================== 导出通道常量（类型已在定义处导出） ====================

export { IPC_CHANNELS }

// 全局类型声明已移至 src/types/index.ts
