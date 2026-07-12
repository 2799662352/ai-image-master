import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { CodexModelContextConfig } from '../../types/agent'
import { isCodexModelContextConfig } from '../../shared/modelSettings'

const SETTINGS_VERSION = 1 as const
const SETTINGS_FILENAME = 'codex-runtime-settings.json'
const DEFAULT_MODEL_CONTEXT_CONFIG: Readonly<CodexModelContextConfig> = {
  modelContextWindow: 200_000,
  modelAutoCompactTokenLimit: 180_000,
}

export interface PersistedCodexRuntimeSettingsV1 {
  version: 1
  confirmed: CodexModelContextConfig
  pending?: {
    target: CodexModelContextConfig
    requestVersion: number
    startedAt: string
  }
}

export interface CodexRuntimeSettingsStoreOptions {
  renameSync?: typeof renameSync
  onDiagnostic?: (message: string, error: unknown) => void
}

function freshDefaults(): PersistedCodexRuntimeSettingsV1 {
  return {
    version: SETTINGS_VERSION,
    confirmed: { ...DEFAULT_MODEL_CONTEXT_CONFIG },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return (
    ownKeys.length === expectedKeys.length
    && ownKeys.every(
      (key) => typeof key === 'string' && expectedKeys.includes(key),
    )
    && expectedKeys.every((key) => Object.hasOwn(value, key))
  )
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validateModelContextConfig(value: unknown): CodexModelContextConfig | null {
  return isCodexModelContextConfig(value) ? { ...value } : null
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function validatePersistedSettings(value: unknown): PersistedCodexRuntimeSettingsV1 | null {
  if (!isRecord(value)) return null
  const hasPending = Object.hasOwn(value, 'pending')
  const rootKeys = hasPending
    ? ['version', 'confirmed', 'pending']
    : ['version', 'confirmed']
  if (!hasExactOwnKeys(value, rootKeys)) return null
  if (value.version !== SETTINGS_VERSION) return null

  const confirmed = validateModelContextConfig(value.confirmed)
  if (!confirmed) return null

  const result: PersistedCodexRuntimeSettingsV1 = {
    version: SETTINGS_VERSION,
    confirmed,
  }
  if (!hasPending) return result
  if (!isRecord(value.pending)) return null
  if (!hasExactOwnKeys(value.pending, ['target', 'requestVersion', 'startedAt'])) return null

  const target = validateModelContextConfig(value.pending.target)
  if (!target) return null
  if (!isPositiveSafeInteger(value.pending.requestVersion)) return null
  if (!isCanonicalIsoTimestamp(value.pending.startedAt)) return null

  result.pending = {
    target,
    requestVersion: value.pending.requestVersion,
    startedAt: value.pending.startedAt,
  }
  return result
}

export class CodexRuntimeSettingsStore {
  private readonly settingsPath: string
  private readonly renameFileSync: typeof renameSync
  private readonly onDiagnostic: (message: string, error: unknown) => void

  constructor(
    userDataDir: string,
    options: CodexRuntimeSettingsStoreOptions = {},
  ) {
    this.settingsPath = path.join(userDataDir, SETTINGS_FILENAME)
    this.renameFileSync = options.renameSync ?? renameSync
    this.onDiagnostic = options.onDiagnostic ?? ((message, error) => {
      console.error(`[CodexRuntimeSettingsStore] ${message}`, error)
    })
  }

  loadSync(): PersistedCodexRuntimeSettingsV1 {
    let raw: string
    try {
      raw = readFileSync(this.settingsPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.onDiagnostic('Failed to read runtime settings; using defaults', error)
      }
      return freshDefaults()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return freshDefaults()
    }

    const persisted = validatePersistedSettings(parsed)
    if (!persisted) return freshDefaults()

    if (persisted.pending) {
      const recovered: PersistedCodexRuntimeSettingsV1 = {
        version: SETTINGS_VERSION,
        confirmed: { ...persisted.confirmed },
      }
      try {
        this.writeAtomic(recovered)
      } catch (error) {
        this.onDiagnostic('Pending runtime settings recovery failed', error)
      }
      return recovered
    }

    return {
      version: SETTINGS_VERSION,
      confirmed: { ...persisted.confirmed },
    }
  }

  replace(next: PersistedCodexRuntimeSettingsV1): void {
    const validated = validatePersistedSettings(next)
    if (!validated) {
      throw new TypeError('Invalid persisted Codex runtime settings')
    }
    this.writeAtomic(validated)
  }

  private writeAtomic(settings: PersistedCodexRuntimeSettingsV1): void {
    const directory = path.dirname(this.settingsPath)
    mkdirSync(directory, { recursive: true })
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.settingsPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    )
    let fileDescriptor: number | null = null

    try {
      fileDescriptor = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(fileDescriptor, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      fsyncSync(fileDescriptor)
      closeSync(fileDescriptor)
      fileDescriptor = null
      this.renameFileSync(temporaryPath, this.settingsPath)
    } finally {
      if (fileDescriptor !== null) {
        try {
          closeSync(fileDescriptor)
        } catch {
          // Best effort: cleanup below still removes our own temp when possible.
        }
      }
      try {
        rmSync(temporaryPath, { force: true })
      } catch {
        // Preserve the original write/rename error; temp cleanup is best effort.
      }
    }
  }
}
