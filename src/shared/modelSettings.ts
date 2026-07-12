import type { CodexModelContextConfig } from '../types/agent'

export const MODEL_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ConcreteModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number]
export type ModelReasoningEffort = 'auto' | ConcreteModelReasoningEffort

export const UNKNOWN_MODEL_CONTEXT_WINDOW = 200_000
export const EXPERIMENTAL_CONTEXT_WINDOW = 1_000_000

export interface ModelContextOption {
  value: number
  experimental: boolean
  conservative?: boolean
}

export interface ModelSettingsCapabilities {
  model: string
  provider: string
  defaultContextWindow: number
  contextOptions: ModelContextOption[]
  defaultReasoningEffort?: string
  supportedReasoningEfforts: ConcreteModelReasoningEffort[]
}

export type CanonicalModelTier = 'Fast' | 'Medium' | 'High' | 'Extra High'

export interface CanonicalModelSettingsRow {
  id: string
  displayName: string
  tier: CanonicalModelTier
  description: string
  isDefault: boolean
}

/**
 * Metadata-only fallback directory shared by main and renderer. Capabilities
 * are deliberately not encoded here: only a live `model/list` response may
 * claim Codex-confirmed reasoning support.
 */
export const CANONICAL_MODEL_SETTINGS_ROWS: readonly CanonicalModelSettingsRow[] = [
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    tier: 'Fast',
    description: 'Fast and affordable agentic coding model (Codex 0.144 catalog).',
    isDefault: false,
  },
  {
    id: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    tier: 'Fast',
    description: 'Smallest GPT-5.4 size. Cheapest, lowest latency.',
    isDefault: false,
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    tier: 'Fast',
    description: 'Compact GPT-5.4. Quick edits, triage, drafting.',
    isDefault: false,
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    tier: 'Medium',
    description: 'Default GPT-5.4. Balanced reasoning and latency.',
    isDefault: false,
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    tier: 'Medium',
    description: 'Balanced agentic coding model for everyday work (Codex 0.144 catalog).',
    isDefault: false,
  },
  {
    id: 'gpt-5.4-2026-03-05',
    displayName: 'GPT-5.4 (2026-03-05 snapshot)',
    tier: 'Medium',
    description: 'Pinned GPT-5.4 snapshot. Use to lock behavior in evals.',
    isDefault: false,
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    tier: 'High',
    description: 'Newer GPT-5.5 family at default reasoning effort.',
    isDefault: true,
  },
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    tier: 'Extra High',
    description: 'Latest frontier agentic coding model (Codex 0.144 catalog).',
    isDefault: false,
  },
] as const

export interface LegacyModelSelection {
  model: string
  reasoningEffort: ModelReasoningEffort
  migrated: boolean
}

const MODEL_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORTS)

const VERIFIED_CONTEXTS: ReadonlyMap<string, number> = new Map([
  ['gpt-5.6-sol', 372_000],
  ['gpt-5.6-terra', 372_000],
  ['gpt-5.6-luna', 372_000],
  ['gpt-5.5', 272_000],
  ['gpt-5.4', 272_000],
  ['gpt-5.4-mini', 272_000],
])

const LEGACY_SELECTIONS: ReadonlyMap<
  string,
  Omit<LegacyModelSelection, 'migrated'>
> = new Map([
  ['gpt-5.4-low', { model: 'gpt-5.4', reasoningEffort: 'low' }],
  ['gpt-5.4-medium', { model: 'gpt-5.4', reasoningEffort: 'medium' }],
  ['gpt-5.4-high', { model: 'gpt-5.4', reasoningEffort: 'high' }],
  ['gpt-5.4-xhigh', { model: 'gpt-5.4', reasoningEffort: 'xhigh' }],
  ['gpt-5.5-xhigh', { model: 'gpt-5.5', reasoningEffort: 'xhigh' }],
])

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return (
    value === 'auto'
    || (typeof value === 'string' && MODEL_REASONING_EFFORT_SET.has(value))
  )
}

export function isConcreteModelReasoningEffort(
  value: unknown,
): value is ConcreteModelReasoningEffort {
  return isModelReasoningEffort(value) && value !== 'auto'
}

export function defaultContextWindowForModel(model: string): number {
  return VERIFIED_CONTEXTS.get(model) ?? UNKNOWN_MODEL_CONTEXT_WINDOW
}

export function modelContextOptions(model: string): ModelContextOption[] {
  const defaultContextWindow = defaultContextWindowForModel(model)
  const defaultOption: ModelContextOption = {
    value: defaultContextWindow,
    experimental: false,
    ...(!VERIFIED_CONTEXTS.has(model) ? { conservative: true } : {}),
  }
  if (defaultContextWindow === EXPERIMENTAL_CONTEXT_WINDOW) {
    return [defaultOption]
  }

  return [
    defaultOption,
    { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
  ]
}

export function mergeModelSettingsCapabilities(input: {
  model: string
  provider: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts: readonly string[]
}): ModelSettingsCapabilities {
  const supported = new Set(input.supportedReasoningEfforts)
  const supportedReasoningEfforts = MODEL_REASONING_EFFORTS.filter((effort) => {
    if (!supported.has(effort)) return false
    return !(
      input.provider === 'rightcode'
      && input.model === 'gpt-5.5'
      && effort === 'max'
    )
  })

  return {
    model: input.model,
    provider: input.provider,
    defaultContextWindow: defaultContextWindowForModel(input.model),
    contextOptions: modelContextOptions(input.model),
    defaultReasoningEffort: input.defaultReasoningEffort,
    supportedReasoningEfforts,
  }
}

/**
 * Migrates only values read from legacy model-picker persistence.
 * Storage version/source boundaries must decide whether a value is legacy.
 */
export function migrateLegacyModelSelection(id: string): LegacyModelSelection {
  const legacy = LEGACY_SELECTIONS.get(id)
  return legacy
    ? { ...legacy, migrated: true }
    : { model: id, reasoningEffort: 'auto', migrated: false }
}

export function modelAutoCompactTokenLimit(contextWindow: number): number {
  return Math.floor(contextWindow * 0.9)
}

const MODEL_CONTEXT_CONFIG_KEYS = [
  'modelContextWindow',
  'modelAutoCompactTokenLimit',
] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

export function isCodexModelContextConfig(
  value: unknown,
): value is CodexModelContextConfig {
  if (!isPlainRecord(value)) return false
  if (!hasExactOwnKeys(value, MODEL_CONTEXT_CONFIG_KEYS)) return false

  const contextWindow = value.modelContextWindow
  const compactLimit = value.modelAutoCompactTokenLimit
  return (
    typeof contextWindow === 'number'
    && Number.isSafeInteger(contextWindow)
    && contextWindow > 0
    && typeof compactLimit === 'number'
    && Number.isSafeInteger(compactLimit)
    && compactLimit > 0
    && compactLimit === modelAutoCompactTokenLimit(contextWindow)
  )
}

export function assertCodexModelContextConfig(
  value: unknown,
): asserts value is CodexModelContextConfig {
  if (!isCodexModelContextConfig(value)) {
    throw new TypeError('Invalid Codex model context config')
  }
}
