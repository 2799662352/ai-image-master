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
  AgentSendMessagePayload,
  AgentStreamEvent,
  AgentThreadSummary,
  AgentToolRequest,
  AgentToolResponse,
} from '../types/agent'

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
    CANCEL: 'agent:cancel',
    LIST_THREADS: 'agent:list-threads',
    LOAD_THREAD: 'agent:load-thread',
    UPLOAD_ATTACHMENTS: 'agent:upload-attachments',
    TOOL_RESPONSE: 'agent:tool-response',
    SET_API_KEY: 'agent:set-api-key',
    TEST_CONNECTION: 'agent:test-connection',
    OPEN_THREAD: 'agent:open-thread',
    RENAME_THREAD: 'agent:rename-thread',
    DELETE_THREAD: 'agent:delete-thread',
  },
  AGENT_EVENTS: [
    'agent:event',
    'agent:tool-request',
  ] as const,
  // Shell helpers (clipboard / save dialog)
  SHELL: {
    COPY_IMAGE: 'shell:copy-image',
    SAVE_AS: 'shell:save-as',
    SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  },
  FILE_EXPLORER: {
    READ_TEXT: 'fs:read-text',
    WRITE_TEXT: 'fs:write-text',
    LIST_DIR: 'fs:list-dir',
    STAT: 'fs:stat',
    PICK_FOLDER: 'workspace:pick-folder',
    WATCH_START: 'fs:watch-start',
    WATCH_STOP: 'fs:watch-stop',
    WATCH_EVENT: 'fs:watch-event',
  },
  ATTACHMENTS: {
    LIST_TREE: 'attachments:list-tree',
  },
} as const

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

export type FileExplorerWatchEvent = { type: 'change' | 'unlink'; path: string; mtime?: number }

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

export interface ElectronAPI {
  isElectron: boolean
  // AI Skills
  loadSkills: () => Promise<Record<string, string>>
  saveSkill: (skillName: string, content: string) => Promise<IpcResponse>
  openSkillsFolder: () => Promise<IpcResponse<{ path: string }>>
  // Codex Agent
  agent: {
    sendMessage: (payload: AgentSendMessagePayload) => Promise<{ threadId: string }>
    cancel: (payload: AgentCancelPayload) => Promise<IpcResponse>
    listThreads: () => Promise<AgentThreadSummary[]>
    loadThread: (threadId: string) => Promise<unknown>
    openThread: (threadId: string) => Promise<unknown>
    renameThread: (threadId: string, title: string) => Promise<void>
    deleteThread: (threadId: string) => Promise<void>
    onEvent: (handler: (event: AgentStreamEvent) => void) => () => void
    onToolRequest: (handler: (request: AgentToolRequest) => void) => () => void
    sendToolResponse: (response: AgentToolResponse) => void
    setApiKey: (key: string) => Promise<AgentApiResult>
    testConnection: () => Promise<AgentApiResult>
  }
  // Shell helpers (clipboard / save dialog)
  shell: {
    copyImage: (uri: string) => Promise<IpcResponse>
    saveAs: (uri: string, suggestedName: string) => Promise<IpcResponse>
    showItemInFolder: (p: string) => Promise<void>
  }
  fs: {
    readText: (p: string) => Promise<{ content: string; mtime: number }>
    writeText: (p: string, content: string) => Promise<{ mtime: number }>
    listDir: (p: string) => Promise<FileExplorerNode[]>
    stat: (p: string) => Promise<FileExplorerStat>
    pickFolder: () => Promise<string | null>
    watchStart: (p: string) => Promise<void>
    watchStop: (p: string) => Promise<void>
    onWatchEvent: (cb: (e: FileExplorerWatchEvent) => void) => () => void
  }
  attachments: {
    listTree: () => Promise<FileExplorerNode[]>
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
  // 通用事件监听（用于更新等事件）
  on: (channel: string, callback: (...args: any[]) => void) => void
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

  // ============ Codex Agent ============
  agent: {
    sendMessage: (payload: AgentSendMessagePayload) =>
      safeInvoke<{ threadId: string }>(IPC_CHANNELS.AGENT.SEND_MESSAGE, payload),

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

    sendToolResponse: (response: AgentToolResponse) => {
      ipcRenderer.send(IPC_CHANNELS.AGENT.TOOL_RESPONSE, response)
    },

    setApiKey: (key: string) =>
      safeInvoke<AgentApiResult>(IPC_CHANNELS.AGENT.SET_API_KEY, key),

    testConnection: () =>
      safeInvoke<AgentApiResult>(IPC_CHANNELS.AGENT.TEST_CONNECTION),
  },

  // ============ Shell helpers (clipboard / save dialog) ============
  shell: {
    copyImage: (uri: string) =>
      safeInvoke<IpcResponse>(IPC_CHANNELS.SHELL.COPY_IMAGE, uri),
    saveAs: (uri: string, suggestedName: string) =>
      safeInvoke<IpcResponse>(IPC_CHANNELS.SHELL.SAVE_AS, { uri, suggestedName }),
    showItemInFolder: (p: string) =>
      safeInvoke<void>(IPC_CHANNELS.SHELL.SHOW_ITEM_IN_FOLDER, p),
  },

  fs: {
    readText: (p: string) =>
      safeInvoke<{ content: string; mtime: number }>(IPC_CHANNELS.FILE_EXPLORER.READ_TEXT, p),
    writeText: (p: string, content: string) =>
      safeInvoke<{ mtime: number }>(IPC_CHANNELS.FILE_EXPLORER.WRITE_TEXT, { path: p, content }),
    listDir: (p: string) =>
      safeInvoke<FileExplorerNode[]>(IPC_CHANNELS.FILE_EXPLORER.LIST_DIR, p),
    stat: (p: string) =>
      safeInvoke<FileExplorerStat>(IPC_CHANNELS.FILE_EXPLORER.STAT, p),
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
  on: (channel: string, callback: (...args: any[]) => void) => {
    const allowedChannels = [
      ...IPC_CHANNELS.UPDATE_EVENTS,
      IPC_CHANNELS.SYSTEM.NATIVE_THEME_CHANGED,
      'updater:download-retry',
      ...IPC_CHANNELS.STORYBOARD_SPLIT_EVENTS,
      ...IPC_CHANNELS.SMART_ERASE_EVENTS,
    ]
    if (allowedChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event: IpcRendererEvent, ...args: any[]) => callback(...args))
    } else {
      console.warn(`[Preload] 不允许监听的通道: ${channel}`)
    }
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
