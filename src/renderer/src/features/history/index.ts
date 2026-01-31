// src/renderer/src/features/history/index.ts
export { HistoryManager, getHistoryManager, createHistoryManager } from './HistoryManager'
export type { HistoryItem, HistoryMetadata, HistoryManagerConfig, HistoryChangeCallback } from './HistoryManager'

export { HistoryDataService, getHistoryDataService, createHistoryDataService } from './HistoryDataService'
export type { StorageStats, HistoryDataServiceConfig, UploadProgressCallback } from './HistoryDataService'
