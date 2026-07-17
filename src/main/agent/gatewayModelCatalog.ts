import { createHash } from 'node:crypto'

import type {
  AgentModelAvailability,
  AgentModelSettingsCatalog,
  AgentModelSettingsEntry,
} from '../../types/agent'
import {
  mergeModelSettingsCapabilities,
} from '../../shared/modelSettings'
import {
  channelsForGateway,
  resolveGatewayModelRoute,
} from './gatewayModelRouting'

/** Inputs required to assemble one gateway-scoped model settings catalog. */
export interface GatewayModelCatalogInput {
  gatewayId: string
  dynamicSource: 'codex' | 'fallback'
  dynamicModels: readonly Omit<
    AgentModelSettingsEntry,
    'family' | 'route' | 'availability'
  >[]
  hasCredential: boolean
  availabilityByModel: ReadonlyMap<string, AgentModelAvailability>
}

/**
 * Derives a stable revision token from visible catalog rows and routing metadata.
 * Only changes when gateway id, routes, availability, or merged capabilities change.
 */
export function modelCatalogRevision(
  gatewayId: string,
  models: readonly AgentModelSettingsEntry[],
): string {
  const stableModels = [...models].sort((left, right) =>
    left.id.localeCompare(right.id))
  return createHash('sha256')
    .update(JSON.stringify({
      gatewayId,
      models: stableModels.map((model) => ({
        id: model.id,
        route: model.route,
        availability: model.availability,
        capabilities: model.capabilities,
      })),
    }))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Builds one gateway-scoped model catalog by merging dynamic Codex rows with
 * statically declared channel models, deduplicating by model id, and attaching
 * authoritative routes plus availability for the active gateway.
 */
export function buildGatewayModelCatalog(
  input: GatewayModelCatalogInput,
): AgentModelSettingsCatalog {
  const byId = new Map<string, AgentModelSettingsEntry>()
  const declaredModels = channelsForGateway(input.gatewayId)
    .flatMap((channel) => [...(channel.allowedModels ?? [])])

  for (const row of input.dynamicModels) {
    const route = resolveGatewayModelRoute(input.gatewayId, row.id)
    const mergedCapabilities = mergeModelSettingsCapabilities({
      model: row.id,
      gatewayId: input.gatewayId,
      channelId: route.channelId,
      defaultReasoningEffort:
        row.capabilities.defaultReasoningEffort,
      supportedReasoningEfforts:
        row.capabilities.supportedReasoningEfforts,
    })
    byId.set(row.id, {
      ...row,
      family: route.family,
      route,
      availability: input.hasCredential
        ? input.availabilityByModel.get(row.id) ?? { status: 'available' }
        : { status: 'needs-key', reason: '请先配置网关 Key' },
      capabilities: {
        ...mergedCapabilities,
        contextOptions: row.capabilities.contextOptions,
      },
    })
  }

  for (const modelId of declaredModels) {
    if (byId.has(modelId)) continue
    const route = resolveGatewayModelRoute(input.gatewayId, modelId)
    byId.set(modelId, {
      id: modelId,
      displayName: modelId === 'grok-4.5' ? 'Grok 4.5' : modelId,
      description: 'Responses model',
      hidden: false,
      isDefault: false,
      family: route.family,
      route,
      availability: input.hasCredential
        ? input.availabilityByModel.get(modelId) ?? { status: 'available' }
        : { status: 'needs-key', reason: '请先配置网关 Key' },
      capabilities: mergeModelSettingsCapabilities({
        model: modelId,
        gatewayId: input.gatewayId,
        channelId: route.channelId,
        supportedReasoningEfforts: [],
      }),
    })
  }

  const models = [...byId.values()]
  return {
    gatewayId: input.gatewayId,
    revision: modelCatalogRevision(input.gatewayId, models),
    source: input.dynamicSource === 'fallback'
      ? 'fallback'
      : declaredModels.length > 0
        ? 'mixed'
        : 'codex',
    models,
  }
}
