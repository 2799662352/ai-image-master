import path from 'node:path'
import type {
  CodexApprovalPolicy,
  CodexModelVerbosity,
  CodexPersonality,
  CodexReasoningSummaryMode,
  CodexSandboxMode,
  CodexSessionConfig,
  CodexWebSearchMode,
} from '../../types/agent'

const SANDBOX_MODES = new Set<CodexSandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
])
const APPROVAL_POLICIES = new Set<CodexApprovalPolicy>([
  'untrusted',
  'on-request',
  'never',
])
const WEB_SEARCH_MODES = new Set<CodexWebSearchMode>([
  'cached',
  'live',
  'indexed',
  'disabled',
])
const PERSONALITIES = new Set<CodexPersonality>([
  'default',
  'none',
  'friendly',
  'pragmatic',
])
const REASONING_SUMMARY_MODES = new Set<CodexReasoningSummaryMode>([
  'auto',
  'concise',
  'detailed',
  'none',
])
const MODEL_VERBOSITIES = new Set<CodexModelVerbosity>([
  'default',
  'low',
  'medium',
  'high',
])

export function validateSessionConfigPatch(
  input: unknown,
  allowedRoots: readonly string[],
): Partial<CodexSessionConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session config patch must be an object')
  }

  const source = input as Record<string, unknown>
  const patch: Partial<CodexSessionConfig> = {}

  if ('sandboxMode' in source) {
    if (!SANDBOX_MODES.has(source.sandboxMode as CodexSandboxMode)) {
      throw new Error('invalid sandboxMode')
    }
    patch.sandboxMode = source.sandboxMode as CodexSandboxMode
  }

  if ('approvalPolicy' in source) {
    if (!APPROVAL_POLICIES.has(source.approvalPolicy as CodexApprovalPolicy)) {
      throw new Error('invalid approvalPolicy')
    }
    patch.approvalPolicy = source.approvalPolicy as CodexApprovalPolicy
  }

  if ('webSearch' in source) {
    if (!WEB_SEARCH_MODES.has(source.webSearch as CodexWebSearchMode)) {
      throw new Error('invalid webSearch')
    }
    patch.webSearch = source.webSearch as CodexWebSearchMode
  }

  if ('personality' in source) {
    if (!PERSONALITIES.has(source.personality as CodexPersonality)) {
      throw new Error('invalid personality')
    }
    patch.personality = source.personality as CodexPersonality
  }

  if ('reasoningSummary' in source) {
    if (!REASONING_SUMMARY_MODES.has(source.reasoningSummary as CodexReasoningSummaryMode)) {
      throw new Error('invalid reasoningSummary')
    }
    patch.reasoningSummary = source.reasoningSummary as CodexReasoningSummaryMode
  }

  if ('showRawReasoning' in source) {
    if (typeof source.showRawReasoning !== 'boolean') {
      throw new Error('invalid showRawReasoning')
    }
    patch.showRawReasoning = source.showRawReasoning
  }

  if ('modelVerbosity' in source) {
    if (!MODEL_VERBOSITIES.has(source.modelVerbosity as CodexModelVerbosity)) {
      throw new Error('invalid modelVerbosity')
    }
    patch.modelVerbosity = source.modelVerbosity as CodexModelVerbosity
  }

  if ('writableRoots' in source) {
    if (!Array.isArray(source.writableRoots)) {
      throw new Error('writableRoots must be a string array')
    }
    const normalizedAllowedRoots = allowedRoots.map((root) => path.resolve(root))
    patch.writableRoots = source.writableRoots.map((root) => {
      if (typeof root !== 'string') {
        throw new Error('writableRoots must be a string array')
      }
      const resolved = path.resolve(root)
      if (!normalizedAllowedRoots.some((allowedRoot) => isRootInsideAllowedRoot(resolved, allowedRoot))) {
        throw new Error(`writable root is outside allowed workspace: ${resolved}`)
      }
      return resolved
    })
  }

  return patch
}

function isRootInsideAllowedRoot(root: string, allowedRoot: string): boolean {
  if (samePath(root, allowedRoot)) return true
  const relative = path.relative(allowedRoot, root)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}
