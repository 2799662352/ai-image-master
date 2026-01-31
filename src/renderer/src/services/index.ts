// src/renderer/src/services/index.ts
/**
 * ����ģ�鵼������
 */

// PageStateManager
export {
  PageStateManager,
  getPageStateManager,
  createPageStateManager,
  resetPageStateManager,
  initPageStateManagerGlobal,
  pageStateManager
} from './PageStateManager'
export type { PageStateConfig, StateWithMeta, ReferenceImage, PageState } from './PageStateManager'

// API ����
export { ApiService, getApiService, createApiService } from './api'
export type { ApiSite, ModelConfig, RatioOption, ModelCapabilities, GenerateImageParams, GenerateResult } from './api'

// �洢�Ž�
export { StorageBridge, getStorageBridge, createStorageBridge } from './storage'
export type { StorageResult, StorageInfo, HistoryItem } from './storage'

// ���ʻ�����
export { I18nService, getI18nService, createI18nService } from './i18n'
export type { Language, I18nConfig, TranslationData, LanguageInfo } from './i18n'

// R2 �ƴ洢����
export { R2StorageService, getR2StorageService, createR2StorageService } from './r2-storage'
export type { R2Config, UploadMetadata, UploadResult, R2ImageInfo } from './r2-storage'

// �汾������
export { VersionChecker, getVersionChecker, createVersionChecker } from './version-checker'
export type { VersionInfo, UpdateCheckResult, VersionCheckerConfig } from './version-checker'

// �����Ž� (JS �� TS Ǩ��֧��)
export {
  initServiceBridge,
  getStorageBridgeAuto,
  getI18nServiceAuto,
  t,
  isServiceBridgeReady
} from './ServiceBridge'
export type { ServiceBridgeConfig } from './ServiceBridge'

// ͼƬ�������
export { ImageCacheService, getImageCacheService, createImageCacheService } from './cache'
export type { CachedImageInfo, HistoryRecord, ImageCacheConfig } from './cache'
