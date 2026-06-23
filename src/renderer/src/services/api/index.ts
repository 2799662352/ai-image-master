// src/renderer/src/services/api/index.ts
// V16.2 C2 - 合并 js/api.js 功能
export {
  ApiService,
  getApiService,
  createApiService,
  resetApiService,
  initApiServiceGlobal
} from './ApiService'
export type {
  ApiSite,
  ModelConfig,
  RatioOption,
  ModelCapabilities,
  GenerateImageParams,
  GenerateResult,
  VisionParams,
  VisionResult,
  UnderstandInput
} from './ApiService'
