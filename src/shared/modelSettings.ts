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
/** xAI documents 500K for the whole Grok 4.x line (4.5 and 4.6 alike). */
export const GROK_CONTEXT_WINDOW = 500_000
/**
 * DeepSeek documents 1M as the default across all official V4 services
 * (https://api-docs.deepseek.com/news/news260424 — "1M Standard").
 * This is not the GPT-family experimental 1M flag; it is the model's
 * documented window, so auto-compaction waits until 900K.
 */
export const DEEPSEEK_CONTEXT_WINDOW = 1_000_000

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
    id: 'gpt-5.5-openai-compact',
    displayName: 'GPT-5.5 OpenAI Compact',
    tier: 'High',
    description: 'Right.Codes compact GPT-5.5 variant (gateway slug; not in Codex model/list).',
    isDefault: false,
  },
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    tier: 'Extra High',
    description: 'Latest frontier agentic coding model (Codex 0.144 catalog).',
    isDefault: false,
  },
  // 通义千问三档（Miau / new-api 网关，完整 OpenAI 兼容 Responses）。这些 slug
  // 之前只在后台跑（qwen 子代理 + MCP 理解工具），现在也能当主对话模型选。
  //
  // ⚠️ 本数组的顺序**不等于**选择器里的顺序。`buildGatewayModelCatalog` 先铺网关
  // `model/list` 回来的动态行、再补静态行，而 qwen 不在 apiyi/rightcode 的
  // model/list 里（它挂在 Miau 上），所以它总是走第二轮、被追加到列表末尾。
  // 产品要求 qwen 排在 Grok 上方 —— 那需要在 catalog 组装处按本数组重排，光挪
  // 这几行没用。改之前先看 gatewayModelCatalog 的两轮循环。
  {
    id: 'qwen3.7-plus-dashscope',
    displayName: 'Qwen 3.7 Plus',
    tier: 'Medium',
    description: '通义千问 3.7 Plus（Miau 网关）。日常够用且更便宜，理解类任务的默认档。',
    isDefault: false,
  },
  {
    id: 'qwen3.7-max-dashscope',
    displayName: 'Qwen 3.7 Max',
    tier: 'High',
    description: '通义千问 3.7 Max（Miau 网关）。比 Plus 更强，长文与复杂推理用它。',
    isDefault: false,
  },
  {
    id: 'qwen3.8-max',
    displayName: 'Qwen 3.8 Max',
    tier: 'Extra High',
    description: '通义千问 3.8 Max（Miau 网关）。最新一代，支持 thinking / reasoning。',
    isDefault: false,
  },
  {
    id: 'qwen3.8-flash',
    displayName: 'Qwen 3.8 Flash',
    tier: 'Fast',
    description: '通义千问 3.8 Flash（Miau 网关）。最新一代里最快最便宜的一档。',
    isDefault: false,
  },
  {
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    tier: 'High',
    description: 'Fast 1M-context V4. Native Responses API; official default chat.',
    isDefault: false,
  },
  {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    tier: 'Extra High',
    description: 'Frontier 1M-context V4. Native Responses API; coding and long-running agents.',
    isDefault: false,
  },
  {
    id: 'grok-4.6',
    displayName: 'Grok 4.6',
    tier: 'Extra High',
    description: 'Newest xAI flagship: coding, tool calling and long-running agents.',
    isDefault: false,
  },
  {
    id: 'grok-4.5',
    displayName: 'Grok 4.5',
    tier: 'Extra High',
    description: 'Frontier coding and agentic model with native Responses support.',
    isDefault: false,
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    tier: 'High',
    description: 'Anthropic mid-tier. Runs through the Responses ⇆ Messages bridge.',
    isDefault: false,
  },
  {
    id: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    tier: 'Extra High',
    description: 'Anthropic frontier model. Bridged, no cross-session memory.',
    isDefault: false,
  },
  {
    id: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    tier: 'Extra High',
    // Only routable on gateways whose Claude channel actually serves it; the
    // picker drops the row elsewhere rather than offering a slug that silently
    // answers as a different model.
    description: 'Anthropic long-form frontier model. API Yi channel only.',
    isDefault: false,
  },
] as const

export interface LegacyModelSelection {
  model: string
  reasoningEffort: ModelReasoningEffort
  migrated: boolean
}

const MODEL_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORTS)

interface ModelContextPolicy {
  defaultWindow: number
  allowExperimental1M: boolean
}

interface ProviderReasoningPolicy {
  defaultEffort: ConcreteModelReasoningEffort
  supportedEfforts: readonly ConcreteModelReasoningEffort[]
}

const VERIFIED_CONTEXT_POLICIES: ReadonlyMap<string, ModelContextPolicy> = new Map([
  ['grok-4.5', {
    defaultWindow: GROK_CONTEXT_WINDOW,
    allowExperimental1M: false,
  }],
  ['grok-4.6', {
    defaultWindow: GROK_CONTEXT_WINDOW,
    allowExperimental1M: false,
  }],
  ['deepseek-v4-flash', {
    defaultWindow: DEEPSEEK_CONTEXT_WINDOW,
    allowExperimental1M: false,
  }],
  ['deepseek-v4-pro', {
    defaultWindow: DEEPSEEK_CONTEXT_WINDOW,
    allowExperimental1M: false,
  }],
  // Codex 0.144.6 hotfix corrected the GPT-5.6 family from 372K to 272K
  // (openai/codex#33972 / #34009) — 372K was wrong upstream metadata.
  ['gpt-5.6-sol', { defaultWindow: 272_000, allowExperimental1M: true }],
  ['gpt-5.6-terra', { defaultWindow: 272_000, allowExperimental1M: true }],
  ['gpt-5.6-luna', { defaultWindow: 272_000, allowExperimental1M: true }],
  ['gpt-5.5', { defaultWindow: 272_000, allowExperimental1M: true }],
  ['gpt-5.5-openai-compact', { defaultWindow: 272_000, allowExperimental1M: true }],
  ['gpt-5.4', { defaultWindow: 272_000, allowExperimental1M: true }],
  ['gpt-5.4-mini', { defaultWindow: 272_000, allowExperimental1M: true }],
])

/**
 * Per-route overrides. Absent a route entry, the model-level policy applies.
 *
 * `grok-4.6` deliberately has NO Right.Codes override, so it lands on the
 * documented 500K instead of inheriting 4.5's 1M. That 1M is the vendor's own
 * advertised figure (see docs/releases/v4.4.1.md), and xAI documents 500K for
 * the whole 4.x line — a number we would only over-claim at the user's
 * expense: the window drives auto-compaction, so claiming 1M means compaction
 * waits for 900K and the request is refused upstream long before that. Under-
 * claiming only compacts sooner than strictly necessary. If Right.Codes states
 * 1M for 4.6 too, add the entry then — with the claim recorded here.
 */
const PROVIDER_CONTEXT_POLICIES: ReadonlyMap<string, ModelContextPolicy> = new Map([
  ['apiyi:apiyi-grok:grok-4.5', {
    defaultWindow: GROK_CONTEXT_WINDOW,
    allowExperimental1M: false,
  }],
  ['rightcode:rightcode-grok:grok-4.5', {
    defaultWindow: 1_000_000,
    allowExperimental1M: false,
  }],
])

/**
 * Effort levels Anthropic documents for its adaptive-thinking models, with
 * Anthropic's own default. The bridge turns Codex's `reasoning.effort` into
 * `output_config.effort`, which is the knob these models expose in place of the
 * retired `thinking.budget_tokens`.
 */
const ANTHROPIC_ADAPTIVE_REASONING: ProviderReasoningPolicy = {
  defaultEffort: 'high',
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
}

/**
 * Claude channels cannot answer `model/list`, so an entry here is the only way
 * the effort picker gets populated for a family whose whole selling point is
 * controllable thinking depth. Keyed per channel because the two gateways do
 * not serve the same slugs — see the `allowedModels` of `rightcode-claude` and
 * `apiyi-claude` for why fable appears on one and not the other.
 */
const ANTHROPIC_ADAPTIVE_CHANNEL_MODELS: readonly string[] = [
  'rightcode:rightcode-claude:claude-opus-5',
  'rightcode:rightcode-claude:claude-sonnet-5',
  'apiyi:apiyi-claude:claude-opus-5',
  'apiyi:apiyi-claude:claude-sonnet-5',
  'apiyi:apiyi-claude:claude-fable-5',
]

/**
 * Efforts verified against the Grok channels. xAI's own docs additionally list
 * `xhigh` for 4.6, but every level here has been exercised through these
 * gateways and that one has not — and an effort the proxy rejects is a failed
 * turn, not a degraded one. Promote it once a live call confirms it.
 */
const GROK_REASONING: ProviderReasoningPolicy = {
  defaultEffort: 'high',
  supportedEfforts: ['low', 'medium', 'high'],
}

/**
 * DeepSeek V4 Responses API documents none/minimal/low/medium/high/xhigh/max
 * (https://api-docs.deepseek.com/guides/thinking_mode). Thinking is on by
 * default at `high`. The actual mapped effort is:
 *   low → low; medium/high/xhigh → high; max → max; none disables thinking.
 *
 * We only expose the three that are not aliases of each other. Offering
 * medium or xhigh would let the user pick a higher label and get `high`
 * with no error — a silent no-op, worse than omitting the row. `none` is
 * not in our picker enum. Promote the aliases only if a live call needs
 * them as distinct UX (it will not change what the model does).
 */
const DEEPSEEK_REASONING: ProviderReasoningPolicy = {
  defaultEffort: 'high',
  supportedEfforts: ['low', 'high', 'max'],
}

const PROVIDER_REASONING_POLICIES: ReadonlyMap<string, ProviderReasoningPolicy> = new Map([
  ['apiyi:apiyi-grok:grok-4.5', GROK_REASONING],
  ['rightcode:rightcode-grok:grok-4.5', GROK_REASONING],
  ['rightcode:rightcode-grok:grok-4.6', GROK_REASONING],
  ['rightcode:rightcode-deepseek:deepseek-v4-flash', DEEPSEEK_REASONING],
  ['rightcode:rightcode-deepseek:deepseek-v4-pro', DEEPSEEK_REASONING],
  ...ANTHROPIC_ADAPTIVE_CHANNEL_MODELS.map(
    (key) => [key, ANTHROPIC_ADAPTIVE_REASONING] as const,
  ),
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

function providerModelKey(
  gatewayId: string,
  channelId: string,
  model: string,
): string {
  return `${gatewayId}:${channelId}:${model}`
}

function contextPolicy(
  model: string,
  route?: { gatewayId: string; channelId: string },
): ModelContextPolicy | undefined {
  if (route) {
    const routed = PROVIDER_CONTEXT_POLICIES.get(
      providerModelKey(route.gatewayId, route.channelId, model),
    )
    if (routed) return routed
  }
  return VERIFIED_CONTEXT_POLICIES.get(model)
}

function contextRoute(
  gatewayId?: string,
  channelId?: string,
): { gatewayId: string; channelId: string } | undefined {
  if (gatewayId === undefined && channelId === undefined) return undefined
  if (gatewayId === undefined || channelId === undefined) {
    throw new TypeError('Gateway and channel ids must be provided together')
  }
  return { gatewayId, channelId }
}

function reasoningPolicy(
  model: string,
  gatewayId: string,
  channelId: string,
): ProviderReasoningPolicy | undefined {
  return PROVIDER_REASONING_POLICIES.get(
    providerModelKey(gatewayId, channelId, model),
  )
}

/** Returns the verified default for a model, optionally scoped to one route. */
export function defaultContextWindowForModel(model: string): number
export function defaultContextWindowForModel(
  model: string,
  gatewayId: string,
  channelId: string,
): number
export function defaultContextWindowForModel(
  model: string,
  gatewayId?: string,
  channelId?: string,
): number {
  return contextPolicy(model, contextRoute(gatewayId, channelId))?.defaultWindow
    ?? UNKNOWN_MODEL_CONTEXT_WINDOW
}

/** Lists verified context choices for a model or an exact gateway route. */
export function modelContextOptions(modelId: string): ModelContextOption[]
export function modelContextOptions(
  modelId: string,
  gatewayId: string,
  channelId: string,
): ModelContextOption[]
export function modelContextOptions(
  modelId: string,
  gatewayId?: string,
  channelId?: string,
): ModelContextOption[] {
  const policy = contextPolicy(modelId, contextRoute(gatewayId, channelId))
  const defaultContextWindow = policy?.defaultWindow ?? UNKNOWN_MODEL_CONTEXT_WINDOW
  const defaultOption: ModelContextOption = {
    value: defaultContextWindow,
    experimental: false,
    ...(!policy ? { conservative: true } : {}),
  }
  if (
    defaultContextWindow === EXPERIMENTAL_CONTEXT_WINDOW
    || policy?.allowExperimental1M === false
  ) {
    return [defaultOption]
  }

  return [
    defaultOption,
    { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
  ]
}

/** Returns the verified reasoning efforts for an exact Gateway + Channel route. */
export function supportedReasoningEfforts(
  modelId: string,
  gatewayId: string,
  channelId: string,
): ConcreteModelReasoningEffort[] {
  const verified = reasoningPolicy(modelId, gatewayId, channelId)
  return verified ? [...verified.supportedEfforts] : []
}

/** Checks a context window against model-only or exact-route policy. */
export function isModelContextWindowSupported(
  model: string,
  contextWindow: number,
): boolean
export function isModelContextWindowSupported(
  model: string,
  contextWindow: number,
  gatewayId: string,
  channelId: string,
): boolean
export function isModelContextWindowSupported(
  model: string,
  contextWindow: number,
  gatewayId?: string,
  channelId?: string,
): boolean {
  const route = contextRoute(gatewayId, channelId)
  if (
    (route
      ? modelContextOptions(model, route.gatewayId, route.channelId)
      : modelContextOptions(model)
    ).some(
      (option) => option.value === contextWindow,
    )
  ) return true
  if (route) return false
  for (const [key, policy] of PROVIDER_CONTEXT_POLICIES) {
    if (
      key.endsWith(`:${model}`)
      && policy.defaultWindow === contextWindow
    ) return true
  }
  return false
}

export function mergeModelSettingsCapabilities(input: {
  model: string
  gatewayId: string
  channelId: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: readonly string[]
}): ModelSettingsCapabilities {
  const verifiedReasoning = reasoningPolicy(
    input.model,
    input.gatewayId,
    input.channelId,
  )
  const supported = new Set(
    (input.supportedReasoningEfforts?.length ?? 0) > 0
      ? input.supportedReasoningEfforts
      : verifiedReasoning?.supportedEfforts ?? [],
  )
  const supportedReasoningEffortsList = MODEL_REASONING_EFFORTS.filter((effort) => {
    if (!supported.has(effort)) return false
    const rightcodeGpt55Family =
      input.model === 'gpt-5.5' || input.model === 'gpt-5.5-openai-compact'
    return !(
      input.gatewayId === 'rightcode'
      && input.channelId === 'rightcode-standard'
      && rightcodeGpt55Family
      && effort === 'max'
    )
  })

  return {
    model: input.model,
    provider: input.gatewayId,
    defaultContextWindow: defaultContextWindowForModel(
      input.model,
      input.gatewayId,
      input.channelId,
    ),
    contextOptions: modelContextOptions(
      input.model,
      input.gatewayId,
      input.channelId,
    ),
    defaultReasoningEffort:
      input.defaultReasoningEffort
      ?? verifiedReasoning?.defaultEffort,
    supportedReasoningEfforts: supportedReasoningEffortsList,
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

/**
 * Context windows Codex resolves natively from its bundled models.json
 * (verified against openai/codex rust-v0.144.6 codex-rs/models-manager/
 * models.json — the 0.144.6 hotfix corrected the GPT-5.6 family from 372K to
 * 272K). Only slugs listed there belong here: for these models Codex already
 * knows the window AND derives its own auto-compaction budget, so a
 * launch-time `model_context_window` override is redundant — and harmful,
 * because the `-c` override applies globally to every model in the process
 * and forces a full restart whenever it changes.
 */
const CODEX_NATIVE_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['gpt-5.6-sol', 272_000],
  ['gpt-5.6-terra', 272_000],
  ['gpt-5.6-luna', 272_000],
  ['gpt-5.5', 272_000],
  ['gpt-5.4', 272_000],
  ['gpt-5.4-mini', 272_000],
  ['gpt-5.2', 272_000],
])

/**
 * Decides whether a selected context window needs a launch-time pin.
 *
 * Returns `null` (unpinned) when the selection matches the model's
 * Codex-native window: the process then launches WITHOUT
 * `model_context_window` / `model_auto_compact_token_limit` overrides and
 * Codex resolves both from its own metadata. Switching between two unpinned
 * models (e.g. gpt-5.5 272K ↔ gpt-5.6-sol 372K) therefore never restarts.
 *
 * Models absent from Codex's catalog (Grok, custom gateways) always pin,
 * because Codex would otherwise fall back to 272K metadata.
 */
export function resolveModelContextPin(
  model: string,
  contextWindow: number,
): CodexModelContextConfig | null {
  const native = CODEX_NATIVE_CONTEXT_WINDOWS.get(model)
  if (native !== undefined && native === contextWindow) return null
  return {
    modelContextWindow: contextWindow,
    modelAutoCompactTokenLimit: modelAutoCompactTokenLimit(contextWindow),
  }
}

/** Structural equality for pins where `null` means "unpinned". */
export function modelContextPinsEqual(
  a: CodexModelContextConfig | null,
  b: CodexModelContextConfig | null,
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.modelContextWindow === b.modelContextWindow
    && a.modelAutoCompactTokenLimit === b.modelAutoCompactTokenLimit
  )
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
