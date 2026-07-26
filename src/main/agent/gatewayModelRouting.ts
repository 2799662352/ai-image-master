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
    channelIds: ['apiyi-standard', 'apiyi-grok'],
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
    // Separate host from the codex/grok channels: this is the vendor's
    // Anthropic-native pool (Messages API, `x-api-key`), the only one of the
    // three that does NOT speak Responses. The `/claude` sibling endpoint is
    // unusable for us — it fingerprints clients and 400s anything that isn't
    // Claude Code.
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
    baseUrl: 'https://right.codes/claude-sale/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'claude-opus-5',
    allowedModels: Object.freeze(['claude-opus-5', 'claude-sonnet-5']),
    requiresOpenaiAuth: true,
    // Anthropic-native upstream: the bridge translates Responses ⇆ Messages
    // in-process because Codex has no Anthropic wire protocol.
    compatibilityPolicy: 'anthropic-messages-bridge',
    // See `CodexProviderConfig.supportsMemories`: the memory pipeline's two
    // phases write malformed artifacts on Claude, and the usual escape hatch
    // (`memoriesModel` → a GPT slug) is unavailable because this endpoint
    // serves Claude only.
    supportsMemories: false,
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
