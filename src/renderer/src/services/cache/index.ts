// src/renderer/src/services/cache/index.ts
/**
 * 缓存服务模块导出
 */

export {
  ImageCacheService,
  getImageCacheService,
  createImageCacheService
} from './ImageCacheService'

export type {
  CachedImageInfo,
  HistoryRecord,
  ImageCacheConfig
} from './ImageCacheService'
