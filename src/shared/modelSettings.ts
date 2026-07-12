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
}

export interface ModelSettingsCapabilities {
  model: string
  provider: string
  defaultContextWindow: number
  contextOptions: ModelContextOption[]
  defaultReasoningEffort?: string
  supportedReasoningEfforts: ConcreteModelReasoningEffort[]
}

export interface LegacyModelSelection {
  model: string
  reasoningEffort: ModelReasoningEffort
  migrated: boolean
}

const MODEL_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORTS)

const VERIFIED_CONTEXTS: Readonly<Record<string, number>> = Object.freeze({
  'gpt-5.6-sol': 372_000,
  'gpt-5.6-terra': 372_000,
  'gpt-5.6-luna': 372_000,
  'gpt-5.5': 272_000,
  'gpt-5.4': 272_000,
  'gpt-5.4-mini': 272_000,
})

const LEGACY_SELECTIONS: Readonly<Record<string, Omit<LegacyModelSelection, 'migrated'>>> =
  Object.freeze({
    'gpt-5.4-low': { model: 'gpt-5.4', reasoningEffort: 'low' },
    'gpt-5.4-medium': { model: 'gpt-5.4', reasoningEffort: 'medium' },
    'gpt-5.4-high': { model: 'gpt-5.4', reasoningEffort: 'high' },
    'gpt-5.4-xhigh': { model: 'gpt-5.4', reasoningEffort: 'xhigh' },
    'gpt-5.5-xhigh': { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
  })

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return (
    value === 'auto'
    || (typeof value === 'string' && MODEL_REASONING_EFFORT_SET.has(value))
  )
}

export function defaultContextWindowForModel(model: string): number {
  return VERIFIED_CONTEXTS[model] ?? UNKNOWN_MODEL_CONTEXT_WINDOW
}

export function modelContextOptions(model: string): ModelContextOption[] {
  const defaultContextWindow = defaultContextWindowForModel(model)
  if (defaultContextWindow === EXPERIMENTAL_CONTEXT_WINDOW) {
    return [{ value: defaultContextWindow, experimental: false }]
  }

  return [
    { value: defaultContextWindow, experimental: false },
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

export function migrateLegacyModelSelection(id: string): LegacyModelSelection {
  const legacy = LEGACY_SELECTIONS[id]
  return legacy
    ? { ...legacy, migrated: true }
    : { model: id, reasoningEffort: 'auto', migrated: false }
}

export function modelAutoCompactTokenLimit(contextWindow: number): number {
  return Math.floor(contextWindow * 0.9)
}
