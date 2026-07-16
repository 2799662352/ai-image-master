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
    channelIds: ['rightcode-standard', 'rightcode-grok'],
  }),
])

const BUILTIN_CHANNELS: readonly ProviderChannelPreset[] = Object.freeze([
  Object.freeze({
    id: 'apiyi-standard',
    gatewayId: 'apiyi',
    name: 'API Yi',
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
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
    compatibilityPolicy: 'responses-namespace-bridge',
  }),
  Object.freeze({
    id: 'rightcode-standard',
    gatewayId: 'rightcode',
    name: 'Right.Codes',
    baseUrl: 'https://right.codes/codex/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5.5',
    requiresOpenaiAuth: true,
    compatibilityPolicy: 'none',
  }),
  Object.freeze({
    id: 'rightcode-grok',
    gatewayId: 'rightcode',
    name: 'Right.Codes Grok',
    baseUrl: 'https://right.codes/grok/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'grok-4.5',
    allowedModels: Object.freeze(['grok-4.5']),
    requiresOpenaiAuth: true,
    compatibilityPolicy: 'none',
  }),
])

/** Maps a model slug to its provider family for channel routing. */
export function inferModelFamily(modelId: string): AgentModelFamily {
  const normalized = modelId.trim().toLowerCase()
  if (normalized.startsWith('grok')) return 'xai'
  if (normalized.startsWith('gpt-') || /^o\d/.test(normalized)) return 'openai'
  return 'other'
}

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

  const channelId = family === 'xai'
    ? `${gatewayId}-grok`
    : `${gatewayId}-standard`
  const channel = resolveProviderChannel(channelId, customProviders)
  if (
    channel.allowedModels
    && !channel.allowedModels.includes(normalizedModel)
  ) {
    throw new Error(
      `Model "${normalizedModel}" is unavailable in gateway "${gatewayId}"`,
    )
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
