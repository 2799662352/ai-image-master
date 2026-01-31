// src/types/index.ts - 核心类型定义

// ==================== 历史记录类型 ====================

export type HistoryItemType = 
  | 'generate' 
  | 'edit' 
  | 'batch' 
  | 'compare' 
  | 'network_restricted'

export interface ComparisonInfo {
  leftModelName: string
  rightModelName: string
  winnerModelName?: string
}

export interface HistoryItem {
  id: number
  prompt: string
  urls: string[]
  timestamp: number
  model: string
  ratio: string
  type: HistoryItemType
  r2Storage?: boolean
  uploading?: boolean
  originalUrls?: string[]
  comparison?: ComparisonInfo
  referenceImages?: string[]
}

// ==================== 存储类型 ====================

export interface StorageInfo {
  historySize: string
  historyCount: number
  totalSize: string
  estimatedLimit: number
  r2Enabled: boolean
  storageMode: 'cloud' | 'local'
}

export interface ElectronStorageInfo {
  imageCount: number
  totalSize: number
  storagePath: string
  isElectron?: boolean
}

// ==================== 页面模块类型 ====================

export interface PageModule {
  onActivate(): void
  onDeactivate(): void
  onLanguageChange?(lang: string): void
}

export type PageName = 
  | 'generate' 
  | 'batch' 
  | 'history' 
  | 'compare' 
  | 'understand' 
  | 'director'

export type PagesMap = Record<PageName, PageModule>

// ==================== 应用状态类型 ====================

export interface AppState {
  currentTab: PageName
  history: HistoryItem[]
  pages: Partial<PagesMap>
}

// ==================== 模型类型 ====================

export interface ModelCapabilities {
  multipleImages: boolean
  customSize: boolean
  aspectRatioControl: boolean
  referenceImage: boolean
  imageEdit: boolean
  intelligentResize?: boolean
}

export interface AIModel {
  id: string
  name: string
  displayName: string
  apiType: string
  baseUrl: string
  capabilities: ModelCapabilities
  maxReferenceImages?: number
}

// ==================== API 类型 ====================

export interface ApiConfig {
  apiKey: string
  model: string
  baseUrl: string
}

export interface GenerateImageParams {
  prompt: string
  model: string
  ratio?: string
  count?: number
  referenceImages?: string[]
}

export interface GenerateImageResult {
  success: boolean
  urls?: string[]
  error?: string
}

// ==================== 页面状态类型 ====================

export interface GeneratePageState {
  prompt: string
  ratio: string
  resolution: string
  generateCount: string
  referenceImages: string[]
  negativePrompt?: string
}

export interface BatchPageState {
  prompts: string[]
  ratio: string
  referenceImages: string[]
}

export interface DirectorPageState {
  layout: string
  scenes: any[]
  referenceImages: string[]
}

// ==================== 模板类型 ====================

export interface PromptTemplate {
  id: string
  name: string
  prompt: string
  category: string
  thumbnail?: string
  isCustom?: boolean
}

export interface TemplateData {
  templates: Record<string, PromptTemplate>
  overrides: Record<string, Partial<PromptTemplate>>
}

// ==================== 图库类型 ====================

export interface GalleryImage {
  id: string
  name: string
  filename: string
  createdAt: string
  path?: string
  url?: string
}

// ==================== 国际化类型 ====================

export type SupportedLanguage = 'zh-CN' | 'en' | 'zh-TW' | 'ru'

export interface I18nInstance {
  t(key: string, params?: Record<string, any>): string
  setLanguage(lang: SupportedLanguage): Promise<void>
  getCurrentLanguage(): SupportedLanguage
}

// ==================== Electron API 类型 ====================

export interface ElectronAPI {
  isElectron: boolean
  saveImage: (base64Data: string, filename: string) => Promise<{ success: boolean; path?: string; error?: string }>
  readImage: (filename: string) => Promise<string | null>
  deleteImage: (filename: string) => Promise<{ success: boolean }>
  saveHistory: (history: HistoryItem[]) => Promise<{ success: boolean; error?: string }>
  loadHistory: () => Promise<HistoryItem[]>
  getStorageInfo: () => Promise<ElectronStorageInfo>
  selectSavePath: () => Promise<string | null>
  exportImage: (base64Data: string, targetDir: string, filename: string) => Promise<{ success: boolean; path?: string; error?: string }>
  openPath: (filePath: string) => Promise<void>
  savePageState: (pageId: string, state: any) => Promise<{ success: boolean; error?: string }>
  loadPageState: (pageId: string) => Promise<any | null>
  clearPageState: (pageId: string) => Promise<{ success: boolean; error?: string }>
  clearAllPageStates: () => Promise<{ success: boolean; error?: string }>
  getSavedPageIds: () => Promise<string[]>
  clearWebCache: () => Promise<{ success: boolean; error?: string }>
  getCacheSize: () => Promise<{ cacheSize: number }>
  saveTemplate: (templateKey: string, templateData: any) => Promise<{ success: boolean; error?: string }>
  saveTemplateOverride: (templateKey: string, templateData: any) => Promise<{ success: boolean; error?: string }>
  loadCustomTemplates: () => Promise<Record<string, any>>
  loadTemplateOverrides: () => Promise<Record<string, any>>
  deleteTemplate: (templateKey: string) => Promise<{ success: boolean; error?: string }>
  resetTemplateOverride: (templateKey: string) => Promise<{ success: boolean; error?: string }>
  exportTemplates: () => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
  importTemplates: () => Promise<{ success: boolean; imported?: { templates: number; overrides: number }; canceled?: boolean; error?: string }>
  saveCustomGallery: (images: GalleryImage[]) => Promise<{ success: boolean; error?: string }>
  loadCustomGallery: () => Promise<GalleryImage[]>
  deleteCustomGalleryImage: (imageId: string) => Promise<{ success: boolean; error?: string }>
  addCustomGalleryImage: (imageData: { id: string; name: string; sourcePath: string }) => Promise<{ success: boolean; filename?: string; path?: string; error?: string }>
  getCustomGalleryPath: () => Promise<string>
}

// ==================== IPC 通道定义 ====================

/**
 * IPC 通道常量定义
 * 用于主进程和渲染进程之间的类型安全通信
 */
export const IpcChannels = {
  // 存储相关
  STORAGE: {
    SAVE_IMAGE: 'storage:save-image',
    READ_IMAGE: 'storage:read-image',
    DELETE_IMAGE: 'storage:delete-image',
    GET_INFO: 'storage:get-info',
    SELECT_PATH: 'storage:select-path',
    EXPORT_IMAGE: 'storage:export-image',
    OPEN_PATH: 'storage:open-path'
  },
  // 历史记录相关
  HISTORY: {
    LOAD: 'history:load',
    SAVE: 'history:save',
    CLEAR: 'history:clear'
  },
  // 页面状态相关
  PAGE_STATE: {
    SAVE: 'page-state:save',
    LOAD: 'page-state:load',
    CLEAR: 'page-state:clear',
    CLEAR_ALL: 'page-state:clear-all',
    GET_IDS: 'page-state:get-ids'
  },
  // 缓存相关
  CACHE: {
    CLEAR_WEB: 'cache:clear-web',
    GET_SIZE: 'cache:get-size'
  },
  // 模板相关
  TEMPLATE: {
    SAVE: 'template:save',
    SAVE_OVERRIDE: 'template:save-override',
    LOAD_CUSTOM: 'template:load-custom',
    LOAD_OVERRIDES: 'template:load-overrides',
    DELETE: 'template:delete',
    RESET_OVERRIDE: 'template:reset-override',
    EXPORT: 'template:export',
    IMPORT: 'template:import'
  },
  // 图库相关
  GALLERY: {
    SAVE: 'gallery:save',
    LOAD: 'gallery:load',
    DELETE_IMAGE: 'gallery:delete-image',
    ADD_IMAGE: 'gallery:add-image',
    GET_PATH: 'gallery:get-path'
  },
  // 应用相关
  APP: {
    GET_VERSION: 'app:get-version',
    OPEN_EXTERNAL: 'app:open-external',
    QUIT: 'app:quit',
    MINIMIZE: 'app:minimize',
    MAXIMIZE: 'app:maximize'
  },
  // 下载相关
  DOWNLOAD: {
    IMAGE: 'download:image',
    IMAGES_ZIP: 'download:images-zip'
  },
  // 自动更新相关
  UPDATER: {
    CHECK: 'updater:check',
    DOWNLOAD: 'updater:download',
    INSTALL: 'updater:install',
    GET_VERSION: 'updater:getVersion',
    GET_STATUS: 'updater:getStatus',
    UPDATE_CONFIG: 'updater:updateConfig',
    CANCEL_DOWNLOAD: 'updater:cancelDownload'
  }
} as const

// 从 IpcChannels 提取通道类型
type StorageChannels = typeof IpcChannels.STORAGE[keyof typeof IpcChannels.STORAGE]
type HistoryChannels = typeof IpcChannels.HISTORY[keyof typeof IpcChannels.HISTORY]
type PageStateChannels = typeof IpcChannels.PAGE_STATE[keyof typeof IpcChannels.PAGE_STATE]
type CacheChannels = typeof IpcChannels.CACHE[keyof typeof IpcChannels.CACHE]
type TemplateChannels = typeof IpcChannels.TEMPLATE[keyof typeof IpcChannels.TEMPLATE]
type GalleryChannels = typeof IpcChannels.GALLERY[keyof typeof IpcChannels.GALLERY]
type AppChannels = typeof IpcChannels.APP[keyof typeof IpcChannels.APP]
type DownloadChannels = typeof IpcChannels.DOWNLOAD[keyof typeof IpcChannels.DOWNLOAD]
type UpdaterChannels = typeof IpcChannels.UPDATER[keyof typeof IpcChannels.UPDATER]

export type IpcChannel = 
  | StorageChannels 
  | HistoryChannels 
  | PageStateChannels 
  | CacheChannels 
  | TemplateChannels 
  | GalleryChannels 
  | AppChannels
  | DownloadChannels
  | UpdaterChannels

// ==================== IPC 请求/响应类型 ====================

/**
 * IPC 基础响应类型
 */
export interface IpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * 存储操作请求类型
 */
export interface SaveImageRequest {
  base64Data: string
  filename: string
}

export interface SaveImageResponse {
  success: boolean
  path?: string
  error?: string
}

export interface ReadImageRequest {
  filename: string
}

export interface DeleteImageRequest {
  filename: string
}

export interface ExportImageRequest {
  base64Data: string
  targetDir: string
  filename: string
}

/**
 * 历史记录请求类型
 */
export interface SaveHistoryRequest {
  history: HistoryItem[]
}

/**
 * 页面状态请求类型
 */
export interface SavePageStateRequest {
  pageId: string
  state: Record<string, any>
}

export interface LoadPageStateRequest {
  pageId: string
}

/**
 * 模板请求类型
 */
export interface SaveTemplateRequest {
  templateKey: string
  templateData: Record<string, any>
}

export interface DeleteTemplateRequest {
  templateKey: string
}

/**
 * 图库请求类型
 */
export interface AddGalleryImageRequest {
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

/**
 * 下载请求类型
 */
export interface DownloadImageRequest {
  url: string
  filename: string
}

export interface DownloadImagesZipRequest {
  urls: string[]
  filename: string
}

// ==================== 自动更新类型 ====================

export type UpdateProvider = 'github' | 'generic' | 's3'

export interface UpdaterConfig {
  provider?: UpdateProvider
  owner?: string
  repo?: string
  token?: string
  url?: string
  bucket?: string
  region?: string
  autoDownload?: boolean
  allowPrerelease?: boolean
  allowDowngrade?: boolean
  maxRetries?: number
  retryDelay?: number
}

export interface UpdateResult {
  success: boolean
  error?: string
  version?: string
}

export interface UpdateProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
  delta: number
  eta?: number
}

export interface UpdateInfo {
  version: string
  currentVersion?: string
  releaseDate?: string
  releaseNotes?: string | null
  files?: unknown[]
  sha512?: string
}

export interface UpdaterStatus {
  isCheckingUpdate: boolean
  isDownloading: boolean
  downloadRetryCount: number
  config: {
    provider: UpdateProvider | undefined
    autoDownload: boolean | undefined
    allowPrerelease: boolean | undefined
  }
}

// ==================== IPC 工具函数类型 ====================

/**
 * 类型安全的 IPC 调用接口
 */
export interface TypedIpcInvoke {
  // 存储相关
  (channel: typeof IpcChannels.STORAGE.SAVE_IMAGE, request: SaveImageRequest): Promise<SaveImageResponse>
  (channel: typeof IpcChannels.STORAGE.READ_IMAGE, request: ReadImageRequest): Promise<string | null>
  (channel: typeof IpcChannels.STORAGE.DELETE_IMAGE, request: DeleteImageRequest): Promise<IpcResponse>
  (channel: typeof IpcChannels.STORAGE.GET_INFO): Promise<ElectronStorageInfo>
  (channel: typeof IpcChannels.STORAGE.SELECT_PATH): Promise<string | null>
  (channel: typeof IpcChannels.STORAGE.EXPORT_IMAGE, request: ExportImageRequest): Promise<SaveImageResponse>
  (channel: typeof IpcChannels.STORAGE.OPEN_PATH, filePath: string): Promise<void>
  
  // 历史记录相关
  (channel: typeof IpcChannels.HISTORY.LOAD): Promise<HistoryItem[]>
  (channel: typeof IpcChannels.HISTORY.SAVE, request: SaveHistoryRequest): Promise<IpcResponse>
  
  // 页面状态相关
  (channel: typeof IpcChannels.PAGE_STATE.SAVE, request: SavePageStateRequest): Promise<IpcResponse>
  (channel: typeof IpcChannels.PAGE_STATE.LOAD, request: LoadPageStateRequest): Promise<Record<string, any> | null>
  (channel: typeof IpcChannels.PAGE_STATE.CLEAR, request: LoadPageStateRequest): Promise<IpcResponse>
  (channel: typeof IpcChannels.PAGE_STATE.CLEAR_ALL): Promise<IpcResponse>
  (channel: typeof IpcChannels.PAGE_STATE.GET_IDS): Promise<string[]>
  
  // 缓存相关
  (channel: typeof IpcChannels.CACHE.CLEAR_WEB): Promise<IpcResponse>
  (channel: typeof IpcChannels.CACHE.GET_SIZE): Promise<{ cacheSize: number }>
  
  // 应用相关
  (channel: typeof IpcChannels.APP.GET_VERSION): Promise<string>
  (channel: typeof IpcChannels.APP.OPEN_EXTERNAL, url: string): Promise<void>
  
  // 自动更新相关
  (channel: typeof IpcChannels.UPDATER.CHECK): Promise<UpdateResult>
  (channel: typeof IpcChannels.UPDATER.DOWNLOAD): Promise<UpdateResult>
  (channel: typeof IpcChannels.UPDATER.INSTALL): Promise<UpdateResult>
  (channel: typeof IpcChannels.UPDATER.GET_VERSION): Promise<string>
  (channel: typeof IpcChannels.UPDATER.GET_STATUS): Promise<UpdaterStatus>
  (channel: typeof IpcChannels.UPDATER.UPDATE_CONFIG, config: Partial<UpdaterConfig>): Promise<UpdateResult>
  (channel: typeof IpcChannels.UPDATER.CANCEL_DOWNLOAD): Promise<UpdateResult>
}

// ==================== IPC 通道映射类型 (v4 增强) ====================

/**
 * IPC 通道到请求/响应类型的完整映射
 * 用于实现完全类型安全的 IPC 调用
 */
export interface IpcChannelMap {
  // 应用
  'app:getVersion': { request: void; response: string }
  'app:quit': { request: void; response: void }
  'app:openExternal': { request: string; response: void }
  
  // 文件/存储
  'file:open': { request: { filters?: string[] }; response: string | null }
  'file:save': { request: { content: string; path: string }; response: boolean }
  'storage:get': { request: { key: string }; response: unknown }
  'storage:set': { request: { key: string; value: unknown }; response: void }
  'storage:save-image': { request: SaveImageRequest; response: SaveImageResponse }
  'storage:read-image': { request: ReadImageRequest; response: string | null }
  'storage:delete-image': { request: DeleteImageRequest; response: IpcResponse }
  'storage:get-info': { request: void; response: ElectronStorageInfo }
  'storage:select-path': { request: void; response: string | null }
  'storage:export-image': { request: ExportImageRequest; response: SaveImageResponse }
  'storage:open-path': { request: string; response: void }
  
  // 历史记录
  'history:load': { request: void; response: HistoryItem[] }
  'history:save': { request: SaveHistoryRequest; response: IpcResponse }
  
  // 页面状态
  'pageState:save': { request: SavePageStateRequest; response: IpcResponse }
  'pageState:load': { request: LoadPageStateRequest; response: Record<string, any> | null }
  'pageState:clear': { request: LoadPageStateRequest; response: IpcResponse }
  'pageState:clearAll': { request: void; response: IpcResponse }
  'pageState:getIds': { request: void; response: string[] }
  
  // 缓存
  'cache:clearWeb': { request: void; response: IpcResponse }
  'cache:getSize': { request: void; response: { cacheSize: number } }
  
  // 更新器
  'updater:check': { request: void; response: UpdateResult }
  'updater:download': { request: void; response: UpdateResult }
  'updater:install': { request: void; response: UpdateResult }
  'updater:getVersion': { request: void; response: string }
  'updater:getStatus': { request: void; response: UpdaterStatus }
  'updater:updateConfig': { request: Partial<UpdaterConfig>; response: UpdateResult }
  'updater:cancelDownload': { request: void; response: UpdateResult }
  
  // 下载
  'download:image': { request: { url: string; filename?: string }; response: IpcResponse }
}

/**
 * 从 IpcChannelMap 提取所有通道名称
 */
export type IpcChannelName = keyof IpcChannelMap

/**
 * 获取指定通道的请求类型
 */
export type IpcRequestType<K extends IpcChannelName> = IpcChannelMap[K]['request']

/**
 * 获取指定通道的响应类型
 */
export type IpcResponseType<K extends IpcChannelName> = IpcChannelMap[K]['response']

/**
 * 类型安全的 invoke 函数类型
 * 用于 preload 脚本中创建类型安全的 IPC 调用
 */
export type TypedInvoke = <K extends IpcChannelName>(
  channel: K,
  ...args: IpcChannelMap[K]['request'] extends void ? [] : [IpcChannelMap[K]['request']]
) => Promise<IpcChannelMap[K]['response']>

/**
 * 创建类型安全 invoke 函数的工厂类型
 */
export type CreateTypedInvoke = <K extends IpcChannelName>(channel: K) => (
  ...args: IpcChannelMap[K]['request'] extends void ? [] : [IpcChannelMap[K]['request']]
) => Promise<IpcChannelMap[K]['response']>

// ==================== 全局类型扩展 ====================

declare global {
  interface Window {
    electronAPI?: ElectronAPI
    app?: any
    aiImageAPI?: any
    r2Storage?: any
    storageBridge?: any
    i18n?: I18nInstance
    versionChecker?: any
    HistoryPage?: any
    GeneratePage?: any
    BatchPage?: any
    ComparePage?: any
    UnderstandPage?: any
    DirectorPage?: any
    PromptTemplates?: any
    // R2 Storage 相关
    CLOUDFLARE_WORKER_URL?: string
    // ServiceBridge 相关
    storageBridgeTS?: any
    i18nServiceTS?: any
    apiServiceTS?: any
    r2StorageTS?: any
    versionCheckerTS?: any
    formatFileSize?: (bytes: number) => string
    formatDate?: (date: Date | string | number, format?: string) => string
    formatRelativeTime?: (date: Date | string | number) => string
    formatNumber?: (num: number) => string
    formatDuration?: (ms: number) => string
    __serviceBridgeInitialized?: boolean
  }
}

export {}
