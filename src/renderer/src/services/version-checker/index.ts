// src/renderer/src/services/version-checker/index.ts
// V16.2 A3 - 合并 js/services/version-checker.js 功能
export {
  VersionChecker,
  getVersionChecker,
  createVersionChecker,
  resetVersionChecker,
  initVersionCheckerGlobal
} from './VersionChecker'
export type { VersionInfo, UpdateCheckResult, VersionCheckerConfig } from './VersionChecker'
