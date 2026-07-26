import type {
  AgentGatewayRecord,
  AgentModelFamily,
  AgentModelRoute,
} from '../../types/agent'
import type {
  CodexProviderConfig,
  ProviderCompatibilityPolicy,
} from './codexLaunch'
import type { ProviderPreset } from './codexProviders'

/** User-facing gateway card with its internal channel ids. */
export interface GatewayPreset extends AgentGatewayRecord {
  channelIds: string[]
}

/** Internal provider channel wired into Codex launch config. */
export interface ProviderChannelPreset extends CodexProviderConfig {
  id: string
  gatewayId: string
  allowedModels?: readonly string[]
  compatibilityPolicy: ProviderCompatibilityPolicy
}

export type AuthorizedGatewayRouteContext =
  | { source: 'builtin'; gatewayId: string }
  | { source: 'model-catalog'; gatewayId: string }

/**
 * Thrown when a model is not in the fixed `allowedModels` list of the
 * builtin Channel its inferred family would route it to (e.g. an
 * unrecognized Grok variant on a single-model Grok Channel). Callers that
 * aggregate many models from an untrusted list (dynamic `model/list` rows)
 * can catch this specific type to skip just the offending row instead of
 * failing the whole catalog.
 */
export class ModelUnavailableInGatewayError extends Error {
  constructor(readonly modelId: string, readonly gatewayId: string) {
    super(`Model "${modelId}" is unavailable in gateway "${gatewayId}"`)
    this.name = 'ModelUnavailableInGatewayError'
  }
}

const BUILTIN_GATEWAYS: readonly GatewayPreset[] = Object.freeze([
  Object.freeze({
    id: 'apiyi',
    name: 'API Yi',
    description: 'API易 Responses 网关',
    credentialId: 'apiyi',
    defaultChannelId: 'apiyi-standard',
    channelIds: ['apiyi-standard', 'apiyi-grok', 'apiyi-claude'],
  }),
  Object.freeze({
    id: 'rightcode',
    name: 'Right.Codes',
    description: 'Right.Codes Codex 与 Grok 网关',
    credentialId: 'rightcode',
    defaultChannelId: 'rightcode-standard',
    channelIds: ['rightcode-standard', 'rightcode-grok', 'rightcode-claude'],
  }),
])

const BUILTIN_CHANNELS: readonly ProviderChannelPreset[] = Object.freeze([
  Object.freeze({
    id: 'apiyi-standard',
    gatewayId: 'apiyi',
    name: 'API Yi',
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
    // Full apiyi endpoint serves gpt-5.5 — run background memory
    // extraction/consolidation on it instead of codex's gpt-5.4 default.
    memoriesModel: 'gpt-5.5',
    compatibilityPolicy: 'none',
  }),
  Object.freeze({
    id: 'apiyi-grok',
    gatewayId: 'apiyi',
    name: 'API Yi Grok',
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'grok-4.5',
    allowedModels: Object.freeze(['grok-4.5']),
    // Same full apiyi endpoint as apiyi-standard (only the chat model is
    // pinned to grok) — memories can use the smarter gpt-5.5.
    memoriesModel: 'gpt-5.5',
    compatibilityPolicy: 'responses-namespace-bridge',
  }),
  Object.freeze({
    id: 'rightcode-standard',
    gatewayId: 'rightcode',
    name: 'Right.Codes',
    baseUrl: 'https://rightapi.ai/codex/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5.5',
    requiresOpenaiAuth: true,
    compatibilityPolicy: 'none',
  }),
  Object.freeze({
    id: 'rightcode-grok',
    gatewayId: 'rightcode',
    name: 'Right.Codes Grok',
    baseUrl: 'https://rightapi.ai/grok/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'grok-4.5',
    allowedModels: Object.freeze(['grok-4.5']),
    requiresOpenaiAuth: true,
    // xAI-backed channel: needs the proxy's input-null sanitize (codex replays
    // reasoning history with `content: null`, which xAI's ModelInput rejects
    // with 422 on every second turn) plus namespace flatten/restore so
    // subagent tools stay callable instead of being stripped upstream.
    compatibilityPolicy: 'responses-namespace-bridge',
  }),
  Object.freeze({
    id: 'rightcode-claude',
    gatewayId: 'rightcode',
    name: 'Right.Codes Claude',
    // Same host as the codex/grok channels, different path: this is the
    // vendor's Anthropic-native pool (Messages API, `x-api-key`), the only one
    // of the three that does NOT speak Responses. The `/claude` sibling
    // endpoint is unusable for us — it fingerprints clients and 400s anything
    // that isn't Claude Code.
    //
    // The pool used to live on `right.codes`, which the vendor has since
    // announced as blocked on mainland networks (path and behaviour unchanged
    // on the new host). Blocked here does not mean refused: connections hang
    // until they time out, so a user on a mainland network saw Claude turns sit
    // there with no error at all.
    //
    // Two quirks of this pool worth knowing before reading token numbers:
    // it prepends its own ~1140-token hidden system prompt (our instructions
    // land after it, and it shows up as cache-read input on every request),
    // and `claude-fable-5` is silently swapped for `claude-opus-4-8` under a
    // content-refusal policy, announced only through a non-standard
    // `{"type":"fallback"}` content block that no SDK — ours included — will
    // surface. Fable is therefore deliberately absent from `allowedModels`:
    // offering a model that never actually runs is worse than not offering it.
    // Date-suffixed slugs 404 here, so they stay out too.
    baseUrl: 'https://rightapi.ai/claude-sale/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'claude-opus-5',
    allowedModels: Object.freeze(['claude-opus-5', 'claude-sonnet-5']),
    requiresOpenaiAuth: true,
    // Anthropic-native upstream: the bridge translates Responses ⇆ Messages
    // in-process because Codex has no Anthropic wire protocol.
    compatibilityPolicy: 'anthropic-messages-bridge',
    // Off because this pool inserts its own breakpoints, so ours are redundant
    // weight against Anthropic's 4-block cap. Measured directly on the
    // upstream's usage block (not the translated one, which under-reported
    // cache counters until `anthropicUsageRepair` landed): a never-before-sent
    // prefix carrying NO `cache_control` billed `cache_creation: 8762` and then
    // read all 8762 back on the repeat. Caching demonstrably works here — the
    // earlier "writes but never reads" reading was the usage bug, not the pool.
    promptCacheBreakpoints: false,
    // See `CodexProviderConfig.supportsMemories`: the memory pipeline's two
    // phases write malformed artifacts on Claude, and the usual escape hatch
    // (`memoriesModel` → a GPT slug) does not reach here. The gateway does sell
    // gpt-5.5, but on its `/codex/v1` sibling host, and `memoriesModel` renames
    // the model without moving the endpoint. On this host `/models` lists 8
    // slugs and none is a GPT, and gpt-5.5 is refused `503 Pricing
    // configuration is temporarily unavailable` on both `/messages` and
    // `/responses` across repeated attempts — while the same key gets 200 for
    // gpt-5.5 on `/codex/v1` and for claude-opus-5 here.
    supportsMemories: false,
  }),
  Object.freeze({
    id: 'apiyi-claude',
    gatewayId: 'apiyi',
    name: 'API Yi Claude',
    // Same host as the other apiyi channels, reached over the Anthropic-native
    // Messages path rather than Responses. `/v1/responses` does answer here for
    // Claude slugs, and choosing it would drop the bridge entirely — but it was
    // measured returning `cached_tokens: 0, cache_write_tokens: 0` on a repeated
    // prefix, matching the vendor's own warning that cache billing engages only
    // on the native format. Bridging costs a translation layer and buys back an
    // order of magnitude on input tokens, so the bridge wins.
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'claude-opus-5',
    // All three slugs are genuinely routed, not aliased. The vendor's public
    // docs list only the 4-x line, so a 200 alone proves nothing — but
    // `/v1/models` advertises 26 Claude slugs including these three, each
    // answers echoing its own name, and a control slug that cannot exist
    // (`claude-opus-9`) is refused with 503 "no available channels for model
    // claude-opus-9". Per-slug routing is therefore real, which is why fable is
    // listed here while it stays out of `rightcode-claude`, where it is
    // silently swapped for opus-4-8.
    allowedModels: Object.freeze(['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']),
    compatibilityPolicy: 'anthropic-messages-bridge',
    // Left on: a repeated prefix billed `input_tokens: 2` +
    // `cache_read_input_tokens: 3972` here, against 3974 uncached.
    promptCacheBreakpoints: true,
    // Unlike the Claude-only rightcode pool, this endpoint also serves gpt-5.5,
    // so the memory pipeline keeps a model that produces well-formed artifacts
    // and the feature stays on. Worth stating because the side request is not
    // exempt from the bridge: it leaves as Responses, gets translated to
    // Messages like everything else on this channel, and lands on `/v1/messages`
    // carrying a GPT slug. That combination was verified to answer 200 here,
    // echoing `model: gpt-5.5-2026-04-23`.
    memoriesModel: 'gpt-5.5',
  }),
])

/** Maps a model slug to its provider family for channel routing. */
export function inferModelFamily(modelId: string): AgentModelFamily {
  const normalized = modelId.trim().toLowerCase()
  if (normalized.startsWith('grok')) return 'xai'
  if (normalized.startsWith('claude')) return 'anthropic'
  if (normalized.startsWith('gpt-') || /^o\d/.test(normalized)) return 'openai'
  return 'other'
}

/**
 * Channel id suffix each family is served from within a builtin gateway.
 *
 * `other` (unrecognized slugs) deliberately falls back to the standard
 * channel: it is the OpenAI-compatible Responses endpoint, which is the only
 * safe guess for a model we cannot classify.
 */
const FAMILY_CHANNEL_SUFFIX: Readonly<Record<AgentModelFamily, string>> =
  Object.freeze({
    openai: 'standard',
    other: 'standard',
    xai: 'grok',
    anthropic: 'claude',
  })

function customGatewayModelRoute(
  gatewayId: string,
  modelId: string,
): AgentModelRoute {
  const normalizedModel = modelId.trim()
  return {
    gatewayId,
    channelId: `custom:${gatewayId}`,
    modelId: normalizedModel,
    family: inferModelFamily(normalizedModel),
  }
}

/** Returns the shipped builtin gateway presets. */
export function builtinGateways(): readonly GatewayPreset[] {
  return BUILTIN_GATEWAYS
}

/** Lists internal channels registered for a gateway id. */
export function channelsForGateway(
  gatewayId: string,
): readonly ProviderChannelPreset[] {
  return BUILTIN_CHANNELS.filter((channel) => channel.gatewayId === gatewayId)
}

/** Resolves a channel id to its launch preset, including custom providers. */
export function resolveProviderChannel(
  channelId: string,
  customProviders: readonly ProviderPreset[] = [],
): ProviderChannelPreset {
  const builtin = BUILTIN_CHANNELS.find((channel) => channel.id === channelId)
  if (builtin) return builtin

  const customId = channelId.startsWith('custom:')
    ? channelId.slice('custom:'.length)
    : channelId
  const custom = customProviders.find((provider) => provider.id === customId)
  if (!custom) throw new Error(`Unknown provider channel "${channelId}"`)

  return {
    ...custom,
    id: `custom:${custom.id}`,
    gatewayId: custom.id,
    compatibilityPolicy: 'none',
  }
}

/** Routes a gateway + model pair to the correct internal channel. */
export function resolveGatewayModelRoute(
  gatewayId: string,
  modelId: string,
  customProviders: readonly ProviderPreset[] = [],
): AgentModelRoute {
  const normalizedModel = modelId.trim()
  const family = inferModelFamily(normalizedModel)
  const builtin = BUILTIN_GATEWAYS.find((gateway) => gateway.id === gatewayId)

  if (!builtin) {
    const custom = customProviders.find((provider) => provider.id === gatewayId)
    if (!custom) throw new Error(`Unknown Codex gateway "${gatewayId}"`)
    return customGatewayModelRoute(gatewayId, normalizedModel)
  }

  const channelId = `${gatewayId}-${FAMILY_CHANNEL_SUFFIX[family]}`
  // Not every gateway serves every family (only rightcode has a Claude pool),
  // and the family→channel mapping is ours, not the caller's. A missing
  // channel is therefore "this gateway can't run this model", the same
  // skippable condition as an `allowedModels` miss — not the malformed-input
  // error `resolveProviderChannel` would raise.
  const channel = BUILTIN_CHANNELS.find((entry) => entry.id === channelId)
  if (
    !channel
    || (channel.allowedModels && !channel.allowedModels.includes(normalizedModel))
  ) {
    throw new ModelUnavailableInGatewayError(normalizedModel, gatewayId)
  }

  return { gatewayId, channelId, modelId: normalizedModel, family }
}

/**
 * Resolves builtin routes normally and permits unknown gateway ids only when
 * their authority comes from a main-produced model catalog.
 */
export function resolveAuthorizedGatewayModelRoute(
  context: AuthorizedGatewayRouteContext,
  modelId: string,
): AgentModelRoute {
  switch (context.source) {
    case 'builtin':
      return resolveGatewayModelRoute(context.gatewayId, modelId)
    case 'model-catalog':
      if (BUILTIN_GATEWAYS.some((gateway) => gateway.id === context.gatewayId)) {
        return resolveGatewayModelRoute(context.gatewayId, modelId)
      }
      if (!context.gatewayId) {
        throw new Error('Catalog-authorized gateway id must be non-empty')
      }
      return customGatewayModelRoute(context.gatewayId, modelId)
    default: {
      const exhaustive: never = context
      throw new Error(`Unknown gateway route authority: ${String(exhaustive)}`)
    }
  }
}

export { BUILTIN_GATEWAYS, BUILTIN_CHANNELS }
