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
import {
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import type { CodexModelContextConfig } from '../../types/agent'
import { isCodexModelContextConfig } from '../../shared/modelSettings'

const SETTINGS_VERSION = 1 as const
const SETTINGS_FILENAME = 'codex-runtime-settings.json'
const replaceRenameTails = new Map<string, Promise<void>>()
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
  renameSyncForRecovery?: typeof renameSync
  openForReplace?: typeof open
  renameForReplace?: typeof rename
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

function serializeSettings(settings: PersistedCodexRuntimeSettingsV1): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}

function uniqueTemporaryPath(settingsPath: string): string {
  return path.join(
    path.dirname(settingsPath),
    `.${path.basename(settingsPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  )
}

async function withReplaceRenameLock(
  settingsPath: string,
  action: () => Promise<void>,
): Promise<void> {
  const previous = replaceRenameTails.get(settingsPath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  replaceRenameTails.set(settingsPath, current)
  await previous

  try {
    await action()
  } finally {
    release()
    if (replaceRenameTails.get(settingsPath) === current) {
      replaceRenameTails.delete(settingsPath)
    }
  }
}

export class CodexRuntimeSettingsStore {
  private readonly settingsPath: string
  private readonly renameSyncForRecovery: typeof renameSync
  private readonly openForReplace: typeof open
  private readonly renameForReplace: typeof rename
  private readonly onDiagnostic: (message: string, error: unknown) => void

  constructor(
    userDataDir: string,
    options: CodexRuntimeSettingsStoreOptions = {},
  ) {
    this.settingsPath = path.join(userDataDir, SETTINGS_FILENAME)
    this.renameSyncForRecovery = options.renameSyncForRecovery ?? renameSync
    this.openForReplace = options.openForReplace ?? open
    this.renameForReplace = options.renameForReplace ?? rename
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
        this.writeAtomicSync(recovered)
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

  async replace(next: PersistedCodexRuntimeSettingsV1): Promise<void> {
    const validated = validatePersistedSettings(next)
    if (!validated) {
      throw new TypeError('Invalid persisted Codex runtime settings')
    }
    await this.writeAtomic(validated)
  }

  private writeAtomicSync(settings: PersistedCodexRuntimeSettingsV1): void {
    const directory = path.dirname(this.settingsPath)
    mkdirSync(directory, { recursive: true })
    const temporaryPath = uniqueTemporaryPath(this.settingsPath)
    let fileDescriptor: number | null = null

    try {
      fileDescriptor = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(fileDescriptor, serializeSettings(settings), 'utf8')
      fsyncSync(fileDescriptor)
      closeSync(fileDescriptor)
      fileDescriptor = null
      this.renameSyncForRecovery(temporaryPath, this.settingsPath)
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

  private async writeAtomic(settings: PersistedCodexRuntimeSettingsV1): Promise<void> {
    const directory = path.dirname(this.settingsPath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = uniqueTemporaryPath(this.settingsPath)
    let handle: FileHandle | null = null

    try {
      handle = await this.openForReplace(temporaryPath, 'wx', 0o600)
      await handle.writeFile(serializeSettings(settings), 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await withReplaceRenameLock(this.settingsPath, async () => {
        await this.renameForReplace(temporaryPath, this.settingsPath)
      })
    } finally {
      if (handle !== null) {
        try {
          await handle.close()
        } catch {
          // Best effort: cleanup below still removes our own temp when possible.
        }
      }
      try {
        await rm(temporaryPath, { force: true })
      } catch {
        // Preserve the original write/rename error; temp cleanup is best effort.
      }
    }
  }
}
