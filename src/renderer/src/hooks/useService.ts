import { useSyncExternalStore, useCallback } from 'react'
import { ServiceRegistry, SERVICE_KEYS } from '../services/ServiceBridge'
import type { ApiService, ApiSite, GenerateImageParams, GenerateResult, VisionParams, VisionResult } from '../services/api'
import type { StorageBridge } from '../services/storage'
import type { I18nService } from '../services/i18n'
import type { R2StorageService } from '../services/r2-storage'
import type { PageStateManager } from '../services/PageStateManager'

function subscribeToRegistry(cb: () => void): () => void {
  const interval = setInterval(() => {
    if (ServiceRegistry.isInitialized()) {
      cb()
      clearInterval(interval)
    }
  }, 100)
  return () => clearInterval(interval)
}

function getRegistrySnapshot(): boolean {
  return ServiceRegistry.isInitialized()
}

export function useServiceReady(): boolean {
  return useSyncExternalStore(subscribeToRegistry, getRegistrySnapshot)
}

export function useApiService(): ApiService {
  return ServiceRegistry.getRequired<ApiService>(SERVICE_KEYS.API)
}

export function useStorageService(): StorageBridge {
  return ServiceRegistry.getRequired<StorageBridge>(SERVICE_KEYS.STORAGE)
}

export function useI18n(): I18nService {
  return ServiceRegistry.getRequired<I18nService>(SERVICE_KEYS.I18N)
}

export function useR2Storage(): R2StorageService {
  return ServiceRegistry.getRequired<R2StorageService>(SERVICE_KEYS.R2_STORAGE)
}

export function usePageState(): PageStateManager {
  return ServiceRegistry.getRequired<PageStateManager>(SERVICE_KEYS.PAGE_STATE)
}

export function useTranslation() {
  const i18n = useI18n()
  const translate = useCallback(
    (key: string, params?: Record<string, string>) => i18n.t(key, params),
    [i18n]
  )
  return { t: translate, i18n }
}

export interface ApiActions {
  generateImage(params: GenerateImageParams): Promise<GenerateResult>
  understandImage(params: VisionParams): Promise<VisionResult>
  testConnection(apiKey: string): Promise<boolean>
  saveApiKey(key: string): boolean
  saveVisionApiKey(key: string): boolean
  getAllSites(): Record<string, ApiSite>
  setSite(key: string): boolean
  getStoredApiKey(siteKey?: string): string | null
  getStoredVisionApiKey(siteKey?: string): string | null
  getCurrentSite(): ApiSite | undefined
  getSiteConfig(key: string): ApiSite | undefined
  readonly currentSiteKey: string
}

export function useApi(): ApiActions {
  const api = useApiService()
  return {
    generateImage: (p) => api.generateImage(p),
    understandImage: (p) => api.understandImage(p),
    testConnection: (k) => api.testConnection(k),
    saveApiKey: (k) => api.saveApiKey(k),
    saveVisionApiKey: (k) => api.saveVisionApiKey(k),
    getAllSites: () => api.getAllSites(),
    setSite: (k) => api.setSite(k),
    getStoredApiKey: (k) => api.getStoredApiKey(k),
    getStoredVisionApiKey: (k) => api.getStoredVisionApiKey(k),
    getCurrentSite: () => api.getCurrentSite(),
    getSiteConfig: (k) => api.getAllSites()[k],
    get currentSiteKey() { return api.currentSiteKey },
  }
}
