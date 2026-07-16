import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_CHANNEL_PRESETS,
  BUILTIN_PROVIDER_PRESETS,
  DEFAULT_PROVIDER_ID,
  RETIRED_RIGHTCODE_PRO_ID,
  credentialIdForProvider,
  isReservedProviderId,
  type ProviderPreset,
} from './codexProviders'

const FILE_NAME = 'codex-providers.json'
const LEGACY_FILE_NAME = 'codex-agent.json'

/**
 * Model slug assigned to a Gateway selection that carries no explicit model
 * (a plain Gateway pick, a custom Provider, or any migrated selection that
 * did not encode a specific model in its legacy id).
 */
const DEFAULT_MODEL_ID = 'gpt-5.5'

/**
 * Persisted shape on disk through v4.4.1. `selectedProviderId` conflated the
 * Gateway choice with the model/channel choice into a single id — a plain
 * Gateway id, an internal Grok channel id, the retired `rightcode-pro` id,
 * or a custom Provider id. Superseded by {@link PersistedProvidersV2}; kept
 * only so `migratePersistedProviders()` can upgrade pre-v4.4.2 files.
 */
export interface PersistedProvidersV1 {
  version: 1
  selectedProviderId: string
  apiKeys: Record<string, string>
  customProviders: ProviderPreset[]
}

/**
 * Current persisted shape (v4.4.2+). The Gateway choice and the model
 * choice are separate fields so one Gateway can host more than one
 * model/channel (e.g. API Yi hosts both GPT and Grok routes) without the
 * store having to know about internal Channels at all — Channel resolution
 * happens purely via `resolveGatewayModelRoute()` at launch time.
 */
export interface PersistedProvidersV2 {
  version: 2
  selectedGatewayId: string
  selectedModelId: string
  apiKeys: Record<string, string>
  customProviders: ProviderPreset[]
}

/** Any persisted shape this store has ever written to disk. */
export type PersistedProviders = PersistedProvidersV1 | PersistedProvidersV2

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

const DEFAULT_STATE: PersistedProvidersV2 = {
  version: 2,
  selectedGatewayId: DEFAULT_PROVIDER_ID,
  selectedModelId: DEFAULT_MODEL_ID,
  apiKeys: {},
  customProviders: [],
}

function clone(state: PersistedProvidersV2): PersistedProvidersV2 {
  return {
    version: 2,
    selectedGatewayId: state.selectedGatewayId,
    selectedModelId: state.selectedModelId,
    apiKeys: { ...state.apiKeys },
    customProviders: state.customProviders.map((p) => ({ ...p })),
  }
}

/**
 * Drops any custom Provider whose id collides with a builtin Gateway or
 * internal Channel id. Reuses `isReservedProviderId()` — the single source
 * of truth for reserved ids established in Task 1 — so this filter and the
 * CRUD guards below can never drift apart.
 */
function dropReservedCustomProviders(state: PersistedProvidersV2): PersistedProvidersV2 {
  return {
    ...state,
    customProviders: state.customProviders.filter((p) => !isReservedProviderId(p.id)),
  }
}

/**
 * Resolves a pre-v4.4.2 `selectedProviderId` into the V2 Gateway + model
 * pair. Looks up internal Channel presets by id (never hardcodes their
 * ids/models) so a stray Channel id — a legacy Grok channel or any future
 * internal channel — can never be persisted as a Gateway id. Shared by the
 * V1→V2 file migration and by {@link CodexProviderStore.setSelectedGatewayId}'s
 * defensive normalization.
 */
function migrateBuiltinSelection(
  selectedProviderId: string,
): Pick<PersistedProvidersV2, 'selectedGatewayId' | 'selectedModelId'> {
  if (selectedProviderId === RETIRED_RIGHTCODE_PRO_ID) {
    return { selectedGatewayId: 'rightcode', selectedModelId: DEFAULT_MODEL_ID }
  }
  const channel = BUILTIN_CHANNEL_PRESETS.find((preset) => preset.id === selectedProviderId)
  if (channel) {
    return {
      selectedGatewayId: channel.gatewayId,
      selectedModelId: channel.model ?? DEFAULT_MODEL_ID,
    }
  }
  return {
    selectedGatewayId: selectedProviderId || DEFAULT_PROVIDER_ID,
    selectedModelId: DEFAULT_MODEL_ID,
  }
}

/**
 * Pure upgrade from any persisted shape to {@link PersistedProvidersV2}. A
 * no-op when already V2. Never copies or drops API keys — `apiKeys` passes
 * through verbatim, since the Gateway/Channel credential-slot scheme is
 * unchanged by this migration.
 */
export function migratePersistedProviders(input: PersistedProviders): PersistedProvidersV2 {
  if (input.version === 2) return input
  const selection = migrateBuiltinSelection(input.selectedProviderId)
  return {
    version: 2,
    ...selection,
    apiKeys: { ...input.apiKeys },
    customProviders: [...input.customProviders],
  }
}

export interface CodexProviderStoreOptions {
  userDataDir: string
}

export class CodexProviderStore {
  private readonly filePath: string
  private readonly legacyFilePath: string
  private cache: PersistedProvidersV2 | undefined
  private mutationChain: Promise<void> = Promise.resolve()

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
   * cache: the next `setApiKey()` / `setSelectedGatewayId()` call will
   * persist it to disk via the regular async write path. We deliberately do
   * NOT sync-rename here so a crash mid-write can never leave a
   * half-written `codex-providers.json` next to the still-readable legacy
   * file.
   */
  loadSync(): PersistedProvidersV2 {
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
    // No v4.3+ file — try the legacy fallback synchronously.
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

  async load(): Promise<PersistedProvidersV2> {
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

  /**
   * Compatibility alias for pre-Gateway/Channel call sites — returns the
   * selected Gateway id. Kept until the renderer is migrated off Provider
   * terminology (see {@link setSelectedId}).
   */
  async getSelectedId(): Promise<string> {
    return this.getSelectedGatewayId()
  }

  /**
   * Compatibility alias for pre-Gateway/Channel call sites: applies the
   * same defensive normalization as {@link setSelectedGatewayId}, so an
   * old-style Provider id (plain Gateway, legacy Grok channel, retired
   * rightcode-pro, or custom Provider) remains safe to pass. Kept until the
   * renderer is migrated off Provider terminology.
   */
  async setSelectedId(id: string): Promise<void> {
    return this.setSelectedGatewayId(id)
  }

  async getSelectedGatewayId(): Promise<string> {
    return (await this.load()).selectedGatewayId
  }

  /**
   * Persists the active Gateway. Normalizes away any internal Channel id
   * (e.g. a legacy `apiyi-grok`) into its owning Gateway id plus the
   * implied model — a Channel id must never be written to
   * `selectedGatewayId`.
   */
  async setSelectedGatewayId(id: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const state = await this.load()
      const selection = migrateBuiltinSelection(id)
      state.selectedGatewayId = selection.selectedGatewayId
      state.selectedModelId = selection.selectedModelId
      await this.persist(state)
    })
  }

  /** Persists the active model id for the currently selected Gateway. */
  async setSelectedModelId(modelId: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const state = await this.load()
      state.selectedModelId = modelId.trim() || DEFAULT_MODEL_ID
      await this.persist(state)
    })
  }

  async getApiKey(id: string): Promise<string> {
    const state = await this.load()
    return state.apiKeys[credentialIdForProvider(id, state.customProviders)] ?? ''
  }

  async setApiKey(id: string, key: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const state = await this.load()
      const credentialId = credentialIdForProvider(id, state.customProviders)
      const trimmed = (key ?? '').trim()
      if (trimmed) state.apiKeys[credentialId] = trimmed
      else delete state.apiKeys[credentialId]
      await this.persist(state)
    })
  }

  async getCustomProviders(): Promise<ProviderPreset[]> {
    return (await this.load()).customProviders.map((p) => ({ ...p }))
  }

  async addCustomProvider(input: NewCustomProvider): Promise<ProviderPreset> {
    return this.enqueueMutation(async () => {
      const state = await this.load()
      const id = input.id?.trim() || `custom-${Date.now().toString(36)}`
      if (isReservedProviderId(id)) {
        throw new Error(`Cannot add custom provider with builtin/internal reserved id "${id}"`)
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
    })
  }

  async updateCustomProvider(
    id: string,
    patch: Partial<Omit<ProviderPreset, 'id' | 'isCustom'>>,
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      if (isReservedProviderId(id)) {
        throw new Error(`Cannot update builtin/internal reserved provider "${id}"`)
      }
      const state = await this.load()
      const idx = state.customProviders.findIndex((p) => p.id === id)
      if (idx < 0) throw new Error(`Custom provider "${id}" not found`)
      const current = state.customProviders[idx]
      state.customProviders[idx] = { ...current, ...patch, id, isCustom: true }
      await this.persist(state)
    })
  }

  async removeCustomProvider(id: string): Promise<void> {
    await this.enqueueMutation(async () => {
      if (isReservedProviderId(id)) {
        throw new Error(`Cannot remove builtin/internal reserved provider "${id}"`)
      }
      const state = await this.load()
      const before = state.customProviders.length
      state.customProviders = state.customProviders.filter((p) => p.id !== id)
      if (state.customProviders.length === before) return
      if (state.selectedGatewayId === id) {
        state.selectedGatewayId = DEFAULT_PROVIDER_ID
        state.selectedModelId = DEFAULT_MODEL_ID
      }
      delete state.apiKeys[id]
      await this.persist(state)
    })
  }

  /**
   * Restore a previously loaded snapshot with the same atomic temp-file rename
   * used by normal writes. AgentManager uses this only to roll back a failed
   * applied-Provider transaction after the desired state was persisted but a
   * replacement backend generation could not be confirmed.
   *
   * Re-validates `customProviders` against the current reserved-id set
   * before writing (closes the gap where a stale snapshot captured before a
   * Channel became reserved could otherwise resurrect a shadow custom
   * Provider on restore).
   */
  async restore(snapshot: PersistedProvidersV2): Promise<void> {
    await this.enqueueMutation(() => this.persist(dropReservedCustomProviders(clone(snapshot))))
  }

  /** Test seam — drops the in-memory cache so the next load() re-reads disk. */
  invalidateCache(): void {
    this.cache = undefined
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(mutation)
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async tryMigrateLegacy(): Promise<PersistedProvidersV2 | null> {
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

  private async persist(state: PersistedProvidersV2): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
    this.cache = clone(state)
  }
}

function sanitizeApiKeys(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([, v]) => typeof v === 'string' && v,
    ) as [string, string][],
  )
}

function sanitizeCustomProviders(raw: unknown): ProviderPreset[] {
  if (!Array.isArray(raw)) return []
  return (raw as ProviderPreset[]).filter(
    (p) =>
      p &&
      typeof p === 'object' &&
      typeof (p as ProviderPreset).id === 'string' &&
      !isReservedProviderId((p as ProviderPreset).id),
  )
}

function parseOrDefault(raw: string): PersistedProvidersV2 {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (parsed.version === 2) {
      const v2 = parsed as Partial<PersistedProvidersV2>
      return {
        version: 2,
        selectedGatewayId:
          typeof v2.selectedGatewayId === 'string' && v2.selectedGatewayId
            ? v2.selectedGatewayId
            : DEFAULT_PROVIDER_ID,
        selectedModelId:
          typeof v2.selectedModelId === 'string' && v2.selectedModelId
            ? v2.selectedModelId
            : DEFAULT_MODEL_ID,
        apiKeys: sanitizeApiKeys(v2.apiKeys),
        customProviders: sanitizeCustomProviders(v2.customProviders),
      }
    }
    const v1 = parsed as Partial<PersistedProvidersV1>
    const sanitizedV1: PersistedProvidersV1 = {
      version: 1,
      selectedProviderId:
        typeof v1.selectedProviderId === 'string' && v1.selectedProviderId
          ? v1.selectedProviderId
          : DEFAULT_PROVIDER_ID,
      apiKeys: sanitizeApiKeys(v1.apiKeys),
      customProviders: sanitizeCustomProviders(v1.customProviders),
    }
    return migratePersistedProviders(migrateRetiredRightcodePro(sanitizedV1))
  } catch {
    return clone(DEFAULT_STATE)
  }
}

/**
 * Read-time migration for the retired `rightcode-pro` preset (Right.Codes
 * merged `/codex-pro` into `/codex` on 2026-06-12; the old route 404s). The
 * saved key moves to the surviving `rightcode` slot — unless the user already
 * has a distinct rightcode key, which wins. Like the legacy codex-agent.json
 * migration this runs before the V1→V2 upgrade, so `migratePersistedProviders`
 * never sees the literal retired id coming from a file load.
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
export function listAllProviders(state: PersistedProvidersV2): ProviderPreset[] {
  return [...BUILTIN_PROVIDER_PRESETS, ...state.customProviders]
}
