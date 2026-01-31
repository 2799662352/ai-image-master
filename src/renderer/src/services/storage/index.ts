// src/renderer/src/services/storage/index.ts
// V16.2 B1 - 合并 js/storage-bridge.js 功能
export {
  StorageBridge,
  getStorageBridge,
  createStorageBridge,
  resetStorageBridge,
  initStorageBridgeGlobal
} from './StorageBridge'
export type { StorageResult, StorageInfo, HistoryItem } from './StorageBridge'
