import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getCodexResourceRoot, resolveCodexBinary } from '../../src/main/agent/paths'
import { CodexProviderStore } from '../../src/main/agent/CodexProviderStore'
import { resolveActiveProvider } from '../../src/main/agent/codexProviders'
import type { CodexProviderConfig } from './codexArgs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Repo root = two levels up from evals/harness/. */
const REPO_ROOT = path.resolve(HERE, '..', '..')

/** Electron `app.getName()` for this app — used to locate the userData dir. */
const APP_NAME = 'catimation-cyberpunk-master'

/** Env var to OVERRIDE the key the app has saved (e.g. a cheap CI key). */
export const EVAL_API_KEY_ENV = 'CODEX_EVAL_API_KEY'
/** Fallback model when neither the env nor the provider preset pins one. */
const FALLBACK_MODEL = 'gpt-5.5'

/**
 * Locate the app's Electron `userData` dir (where CodexProviderStore lives),
 * mirroring Electron's per-platform default for `app.getPath('userData')`.
 */
export function resolveUserDataDir(appName = APP_NAME): string {
  if (process.env.CODEX_EVAL_USER_DATA_DIR) return process.env.CODEX_EVAL_USER_DATA_DIR
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), appName)
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName)
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), appName)
  }
}

/** The active provider + key as the RUNNING APP would resolve them. */
export interface AppCreds {
  apiKey: string
  provider: CodexProviderConfig
}

/**
 * Resolve the active provider + its saved API key straight from the app's
 * `codex-providers.json` (so evals run against the SAME gateway the user's app
 * uses). Returns `null` when settings are missing or the active provider has no
 * stored key.
 */
export function resolveAppCreds(): AppCreds | null {
  try {
    const store = new CodexProviderStore({ userDataDir: resolveUserDataDir() })
    const state = store.loadSync()
    const provider = resolveActiveProvider(state.selectedGatewayId, state.customProviders)
    const apiKey = (state.apiKeys[state.selectedGatewayId] ?? '').trim()
    if (!apiKey) return null
    return { apiKey, provider }
  } catch {
    return null
  }
}

/**
 * True when live agent-loop scenarios have what they need — either an explicit
 * `CODEX_EVAL_API_KEY`, or a key saved in the app's provider settings.
 */
export function hasEvalCreds(): boolean {
  if (process.env[EVAL_API_KEY_ENV]?.trim()) return true
  return resolveAppCreds() !== null
}

/** Absolute path to the bundled codex binary, regardless of whether it exists. */
function codexBinaryCandidate(): string {
  return resolveCodexBinary(getCodexResourceRoot({ appPath: REPO_ROOT, isPackaged: false }))
}

/**
 * Resolve the bundled codex binary path, throwing a clear error when it's
 * missing. Useful for OFFLINE scenarios (e.g. the `thread/resume` wiring check)
 * that need the real binary but no API key.
 */
export function resolveCodexBinaryPath(): string {
  const binaryPath = codexBinaryCandidate()
  if (!existsSync(binaryPath)) {
    throw new Error(`Bundled codex binary not found at ${binaryPath}. Run \`npm run codex:fetch\` first.`)
  }
  return binaryPath
}

/** True when the bundled codex binary is present (gate offline binary tests). */
export function hasCodexBinary(): boolean {
  try {
    return existsSync(codexBinaryCandidate())
  } catch {
    return false
  }
}

export interface EvalConfig {
  apiKey: string
  /** Full provider config forwarded to `buildExecArgs` (apiyi by default). */
  provider: CodexProviderConfig
  /** Env var the provider reads the key from (apiyi → OPENAI_API_KEY). */
  providerEnvKey: string
  /** Model slug used for the run. */
  model: string
  /** Absolute path to the bundled codex binary the app ships. */
  binaryPath: string
  /** Absolute path to the stdio stub MCP entry. */
  stubPath: string
}

/**
 * Resolve everything the live runner needs. Precedence:
 *   - key:      CODEX_EVAL_API_KEY  >  app's saved key for the active provider
 *   - provider: CODEX_EVAL_BASE_URL (custom gateway)  >  app's active provider
 *   - model:    CODEX_EVAL_MODEL  >  provider preset model  >  gpt-5.5
 * Throws (clearly) if no key and no bundled binary — call after {@link hasEvalCreds}.
 */
export function resolveEvalConfig(): EvalConfig {
  const app = resolveAppCreds()
  const envKeyOverride = process.env[EVAL_API_KEY_ENV]?.trim()
  const apiKey = envKeyOverride || app?.apiKey
  if (!apiKey) {
    throw new Error(
      `No eval credentials: set ${EVAL_API_KEY_ENV} or sign in inside the app ` +
        `(no saved key found in ${path.join(resolveUserDataDir(), 'codex-providers.json')}).`,
    )
  }

  const baseUrlOverride = process.env.CODEX_EVAL_BASE_URL?.trim()
  const provider: CodexProviderConfig = baseUrlOverride
    ? { id: 'evalgw', name: 'Eval Gateway', baseUrl: baseUrlOverride, envKey: EVAL_API_KEY_ENV }
    : (app?.provider ?? { id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' })

  const model = process.env.CODEX_EVAL_MODEL?.trim() || provider.model || FALLBACK_MODEL

  const binaryPath = resolveCodexBinaryPath()

  return {
    apiKey,
    provider,
    providerEnvKey: provider.envKey,
    model,
    binaryPath,
    stubPath: path.join(HERE, 'stub', 'stub.mjs'),
  }
}
