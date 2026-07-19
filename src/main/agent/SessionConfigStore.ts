import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CodexSessionConfig } from '../../types/agent'
import { DEFAULT_CODEX_SESSION_CONFIG } from './codexLaunch'
import { validateSessionConfigPatch } from './sessionConfigValidation'

const STORE_VERSION = 1 as const
const STORE_FILENAME = 'agent-session-config.json'

/**
 * Session-config keys that may be persisted as user defaults.
 * `writableRoots` is deliberately excluded: it is derived from the OPEN
 * workspace at runtime (`setAllowedRoots`) and restoring a stale set from a
 * previous session would either point at missing directories or silently
 * widen the sandbox beyond the current workspace.
 */
const PERSISTABLE_KEYS = [
  'sandboxMode',
  'approvalPolicy',
  'webSearch',
  'personality',
  'reasoningSummary',
  'showRawReasoning',
  'modelVerbosity',
] as const

type PersistableKey = (typeof PERSISTABLE_KEYS)[number]
export type SessionConfigOverrides = Partial<Pick<CodexSessionConfig, PersistableKey>>

interface PersistedSessionConfigV1 {
  version: 1
  overrides: SessionConfigOverrides
}

/**
 * User-confirmed session-config defaults, persisted across app restarts
 * (docs/plans/2026-07-19-session-settings-batch2.md, batch 1).
 *
 * Contract:
 * - Stores only the DIFF against {@link DEFAULT_CODEX_SESSION_CONFIG}; an
 *   empty diff deletes the file, so pristine installs stay file-less and
 *   byte-identical to pre-persistence builds.
 * - Written ONLY when the user ticks "保存为默认" on Apply (main process
 *   passes the full post-patch config to {@link saveSync}); the plain Apply
 *   path never touches disk, keeping the historical in-memory semantics.
 * - Reads fail safe: corrupt JSON, unknown versions, or any invalid enum
 *   value reject the WHOLE file (empty overrides → factory defaults). We
 *   deliberately do not salvage partial content — a half-applied snapshot is
 *   harder to reason about than a clean reset.
 *
 * Plain JSON file (not electron-store): keeps the agent store family
 * consistent (CodexProviderStore / CodexRuntimeSettingsStore are also
 * hand-rolled JSON in userData) and avoids pulling the lazily-loaded
 * electron-store dependency into the agent boot path.
 */
export class SessionConfigStore {
  private readonly storePath: string
  private readonly onDiagnostic: (message: string, error: unknown) => void

  constructor(
    userDataDir: string,
    options: { onDiagnostic?: (message: string, error: unknown) => void } = {},
  ) {
    this.storePath = path.join(userDataDir, STORE_FILENAME)
    this.onDiagnostic = options.onDiagnostic ?? ((message, error) => {
      console.error(`[SessionConfigStore] ${message}`, error)
    })
  }

  /** Persisted overrides, or `{}` when absent/corrupt (factory defaults). */
  loadSync(): SessionConfigOverrides {
    let raw: string
    try {
      raw = readFileSync(this.storePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.onDiagnostic('Failed to read persisted session config; using defaults', error)
      }
      return {}
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    if (
      !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed as PersistedSessionConfigV1).version !== STORE_VERSION
    ) {
      return {}
    }
    const overrides = (parsed as PersistedSessionConfigV1).overrides
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return {}

    const candidate: Record<string, unknown> = {}
    for (const key of PERSISTABLE_KEYS) {
      if (key in overrides) candidate[key] = (overrides as Record<string, unknown>)[key]
    }
    try {
      // Reuse the IPC patch validator so persisted values can never be looser
      // than what the settings panel is allowed to send.
      return validateSessionConfigPatch(candidate, []) as SessionConfigOverrides
    } catch (error) {
      this.onDiagnostic('Persisted session config failed validation; using defaults', error)
      return {}
    }
  }

  /**
   * Persist the diff of `config` against the factory defaults. A config equal
   * to the defaults removes the file entirely (reset-to-factory semantics).
   */
  saveSync(config: CodexSessionConfig): void {
    const overrides: SessionConfigOverrides = {}
    for (const key of PERSISTABLE_KEYS) {
      if (config[key] !== DEFAULT_CODEX_SESSION_CONFIG[key]) {
        (overrides as Record<string, unknown>)[key] = config[key]
      }
    }
    if (Object.keys(overrides).length === 0) {
      this.clearSync()
      return
    }
    const payload: PersistedSessionConfigV1 = { version: STORE_VERSION, overrides }
    this.writeAtomicSync(`${JSON.stringify(payload, null, 2)}\n`)
  }

  clearSync(): void {
    try {
      rmSync(this.storePath, { force: true })
    } catch (error) {
      this.onDiagnostic('Failed to clear persisted session config', error)
    }
  }

  hasPersistedOverrides(): boolean {
    return Object.keys(this.loadSync()).length > 0
  }

  private writeAtomicSync(contents: string): void {
    mkdirSync(path.dirname(this.storePath), { recursive: true })
    const temporaryPath = path.join(
      path.dirname(this.storePath),
      `.${path.basename(this.storePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    try {
      writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, this.storePath)
    } finally {
      try {
        rmSync(temporaryPath, { force: true })
      } catch {
        // Preserve the original error; temp cleanup is best effort.
      }
    }
  }
}
