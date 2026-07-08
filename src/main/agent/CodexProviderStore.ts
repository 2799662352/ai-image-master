import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_PROVIDER_PRESETS,
  DEFAULT_PROVIDER_ID,
  RETIRED_RIGHTCODE_PRO_ID,
  isBuiltinProviderId,
  type ProviderPreset,
} from './codexProviders'

const FILE_NAME = 'codex-providers.json'
const LEGACY_FILE_NAME = 'codex-agent.json'

/**
 * Persisted shape on disk. `version` lets us evolve the schema later without
 * refusing to load pre-v4.3 settings — the load path always upgrades into the
 * current shape.
 */
export interface PersistedProvidersV1 {
  version: 1
  selectedProviderId: string
  apiKeys: Record<string, string>
  customProviders: ProviderPreset[]
}

export interface NewCustomProvider {
  /** Optional explicit id. When omitted, the store assigns `custom-<ts>`. */
  id?: string
  name: string
  baseUrl: string
  envKey: string
  model?: string
  reasoningEffort?: string
  verbosity?: string
  requiresOpenaiAuth?: boolean
  extraTopLevelConfig?: Readonly<Record<string, string | boolean | number>>
  description?: string
}

const DEFAULT_STATE: PersistedProvidersV1 = {
  version: 1,
  selectedProviderId: DEFAULT_PROVIDER_ID,
  apiKeys: {},
  customProviders: [],
}

function clone(state: PersistedProvidersV1): PersistedProvidersV1 {
  return {
    version: 1,
    selectedProviderId: state.selectedProviderId,
    apiKeys: { ...state.apiKeys },
    customProviders: state.customProviders.map((p) => ({ ...p })),
  }
}

export interface CodexProviderStoreOptions {
  userDataDir: string
}

export class CodexProviderStore {
  private readonly filePath: string
  private readonly legacyFilePath: string
  private cache: PersistedProvidersV1 | undefined

  constructor(opts: CodexProviderStoreOptions) {
    this.filePath = path.join(opts.userDataDir, FILE_NAME)
    this.legacyFilePath = path.join(opts.userDataDir, LEGACY_FILE_NAME)
  }

  /**
   * Synchronous load — used at AgentManager construction time so we can wire
   * the active provider into the spawn config without forcing the rest of
   * `main/index.ts` to be async-aware. Falls back to defaults on every
   * recoverable failure (missing file, malformed JSON).
   *
   * When the v4.3 file is missing but a legacy `codex-agent.json` is
   * present, this performs a *read-only* migration into the in-memory
   * cache: the next `setApiKey()` / `setSelectedId()` call will persist it
   * to disk via the regular async write path. We deliberately do NOT
   * sync-rename here so a crash mid-write can never leave a half-written
   * `codex-providers.json` next to the still-readable legacy file.
   */
  loadSync(): PersistedProvidersV1 {
    if (this.cache) return clone(this.cache)
    let raw: string | undefined
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      raw = undefined
    }
    if (raw !== undefined) {
      const parsed = parseOrDefault(raw)
      this.cache = parsed
      return clone(parsed)
    }
    // No v4.3 file — try the legacy fallback synchronously.
    let legacyRaw: string | undefined
    try {
      legacyRaw = readFileSync(this.legacyFilePath, 'utf8')
    } catch {
      legacyRaw = undefined
    }
    if (legacyRaw !== undefined) {
      try {
        const legacy = JSON.parse(legacyRaw) as { openaiApiKey?: unknown }
        const key =
          typeof legacy.openaiApiKey === 'string' ? legacy.openaiApiKey.trim() : ''
        if (key) {
          const fresh = clone(DEFAULT_STATE)
          fresh.apiKeys[DEFAULT_PROVIDER_ID] = key
          this.cache = fresh
          return clone(fresh)
        }
      } catch {
        // Fall through to defaults on malformed legacy content.
      }
    }
    this.cache = clone(DEFAULT_STATE)
    return clone(this.cache)
  }

  async load(): Promise<PersistedProvidersV1> {
    if (this.cache) return clone(this.cache)
    let raw: string | undefined
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    if (raw) {
      const parsed = parseOrDefault(raw)
      this.cache = parsed
      return clone(parsed)
    }

    // Try legacy migration once.
    const migrated = await this.tryMigrateLegacy()
    if (migrated) {
      await this.persist(migrated)
      this.cache = migrated
      return clone(migrated)
    }

    this.cache = clone(DEFAULT_STATE)
    return clone(this.cache)
  }

  async getSelectedId(): Promise<string> {
    return (await this.load()).selectedProviderId
  }

  async setSelectedId(id: string): Promise<void> {
    const state = await this.load()
    state.selectedProviderId = id || DEFAULT_PROVIDER_ID
    await this.persist(state)
  }

  async getApiKey(id: string): Promise<string> {
    const state = await this.load()
    return state.apiKeys[id] ?? ''
  }

  async setApiKey(id: string, key: string): Promise<void> {
    const state = await this.load()
    const trimmed = (key ?? '').trim()
    if (trimmed) state.apiKeys[id] = trimmed
    else delete state.apiKeys[id]
    await this.persist(state)
  }

  async getCustomProviders(): Promise<ProviderPreset[]> {
    return (await this.load()).customProviders.map((p) => ({ ...p }))
  }

  async addCustomProvider(input: NewCustomProvider): Promise<ProviderPreset> {
    const state = await this.load()
    const id = input.id?.trim() || `custom-${Date.now().toString(36)}`
    if (isBuiltinProviderId(id)) {
      throw new Error(`Cannot add custom provider with builtin id "${id}"`)
    }
    if (state.customProviders.some((p) => p.id === id)) {
      throw new Error(`Custom provider with id "${id}" already exists`)
    }
    const created: ProviderPreset = {
      id,
      name: input.name,
      baseUrl: input.baseUrl,
      envKey: input.envKey || 'OPENAI_API_KEY',
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.verbosity !== undefined ? { verbosity: input.verbosity } : {}),
      ...(input.requiresOpenaiAuth !== undefined
        ? { requiresOpenaiAuth: input.requiresOpenaiAuth }
        : {}),
      ...(input.extraTopLevelConfig
        ? { extraTopLevelConfig: { ...input.extraTopLevelConfig } }
        : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      isCustom: true,
    }
    state.customProviders.push(created)
    await this.persist(state)
    return { ...created }
  }

  async updateCustomProvider(
    id: string,
    patch: Partial<Omit<ProviderPreset, 'id' | 'isCustom'>>,
  ): Promise<void> {
    if (isBuiltinProviderId(id)) {
      throw new Error(`Cannot update builtin provider "${id}"`)
    }
    const state = await this.load()
    const idx = state.customProviders.findIndex((p) => p.id === id)
    if (idx < 0) throw new Error(`Custom provider "${id}" not found`)
    const current = state.customProviders[idx]
    state.customProviders[idx] = { ...current, ...patch, id, isCustom: true }
    await this.persist(state)
  }

  async removeCustomProvider(id: string): Promise<void> {
    if (isBuiltinProviderId(id)) {
      throw new Error(`Cannot remove builtin provider "${id}"`)
    }
    const state = await this.load()
    const before = state.customProviders.length
    state.customProviders = state.customProviders.filter((p) => p.id !== id)
    if (state.customProviders.length === before) return
    if (state.selectedProviderId === id) state.selectedProviderId = DEFAULT_PROVIDER_ID
    delete state.apiKeys[id]
    await this.persist(state)
  }

  /** Test seam — drops the in-memory cache so the next load() re-reads disk. */
  invalidateCache(): void {
    this.cache = undefined
  }

  private async tryMigrateLegacy(): Promise<PersistedProvidersV1 | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.legacyFilePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      return null
    }
    let legacy: { openaiApiKey?: unknown }
    try {
      legacy = JSON.parse(raw)
    } catch {
      return null
    }
    const key =
      typeof legacy.openaiApiKey === 'string' ? legacy.openaiApiKey.trim() : ''
    if (!key) return null
    const fresh = clone(DEFAULT_STATE)
    fresh.apiKeys[DEFAULT_PROVIDER_ID] = key
    return fresh
  }

  private async persist(state: PersistedProvidersV1): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
    this.cache = clone(state)
  }
}

function parseOrDefault(raw: string): PersistedProvidersV1 {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedProvidersV1>
    return migrateRetiredRightcodePro({
      version: 1,
      selectedProviderId:
        typeof parsed.selectedProviderId === 'string' && parsed.selectedProviderId
          ? parsed.selectedProviderId
          : DEFAULT_PROVIDER_ID,
      apiKeys:
        parsed.apiKeys && typeof parsed.apiKeys === 'object' && !Array.isArray(parsed.apiKeys)
          ? Object.fromEntries(
              Object.entries(parsed.apiKeys as Record<string, unknown>).filter(
                ([, v]) => typeof v === 'string' && v,
              ) as [string, string][],
            )
          : {},
      customProviders: Array.isArray(parsed.customProviders)
        ? (parsed.customProviders as ProviderPreset[]).filter(
            (p) =>
              p &&
              typeof p === 'object' &&
              typeof (p as ProviderPreset).id === 'string' &&
              !isBuiltinProviderId((p as ProviderPreset).id),
          )
        : [],
    })
  } catch {
    return clone(DEFAULT_STATE)
  }
}

/**
 * Read-time migration for the retired `rightcode-pro` preset (Right.Codes
 * merged `/codex-pro` into `/codex` on 2026-06-12; the old route 404s). The
 * saved key moves to the surviving `rightcode` slot — unless the user already
 * has a distinct rightcode key, which wins. Like the legacy codex-agent.json
 * migration this is in-memory only; the next write persists the new shape.
 */
function migrateRetiredRightcodePro(state: PersistedProvidersV1): PersistedProvidersV1 {
  const proKey = state.apiKeys[RETIRED_RIGHTCODE_PRO_ID]
  if (proKey !== undefined) {
    if (!state.apiKeys.rightcode) state.apiKeys.rightcode = proKey
    delete state.apiKeys[RETIRED_RIGHTCODE_PRO_ID]
  }
  if (state.selectedProviderId === RETIRED_RIGHTCODE_PRO_ID) {
    state.selectedProviderId = 'rightcode'
  }
  return state
}

/** Public — useful when callers want the resolved active provider record. */
export function listAllProviders(state: PersistedProvidersV1): ProviderPreset[] {
  return [...BUILTIN_PROVIDER_PRESETS, ...state.customProviders]
}
