// src/renderer/src/features/error-handler/index.ts
export { ErrorHandler, getErrorHandler, createErrorHandler } from './ErrorHandler'
export type { ErrorInfo, NetworkTestResults, ErrorHandlerConfig } from './ErrorHandler'

export {
  NetworkDiagnosticsModal,
  getNetworkDiagnosticsModal,
  createNetworkDiagnosticsModal
} from './NetworkDiagnosticsModal'
export type {
  NetworkRestrictedInfo,
  NetworkDiagnosticsConfig
} from './NetworkDiagnosticsModal'
