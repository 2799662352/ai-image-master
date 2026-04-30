// Re-exports for callers that don't want to import from the shared
// `tencent/credentials` layer directly. Keeps the smartErase service
// surface self-contained.

export {
  getCredentials,
  setCredentials,
  getCredentialState,
} from '../tencent/credentials'

export { DEFAULT_ERASE_CONFIG } from '../../../types/smartErase'
