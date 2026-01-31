// src/renderer/src/services/r2-storage/index.ts
// V16.2 B3 - 合并 js/services/r2-storage.js 功能
export {
  R2StorageService,
  getR2StorageService,
  createR2StorageService,
  resetR2StorageService,
  initR2StorageGlobal
} from './R2StorageService'
export type { R2Config, UploadMetadata, UploadResult, R2ImageInfo } from './R2StorageService'
