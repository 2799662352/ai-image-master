import { createHash } from 'node:crypto'

import type {
  AgentModelAvailability,
  AgentModelRoute,
  AgentModelSettingsCatalog,
  AgentModelSettingsEntry,
} from '../../types/agent'
import type { ProviderPreset } from './codexProviders'
import {
  CANONICAL_MODEL_SETTINGS_ROWS,
  mergeModelSettingsCapabilities,
  type ModelSettingsCapabilities,
} from '../../shared/modelSettings'
import {
  channelsForGateway,
  ModelUnavailableInGatewayError,
  resolveGatewayModelRoute,
} from './gatewayModelRouting'

/**
 * One dynamically discovered (live Codex `model/list`) or canonical-fallback
 * model row awaiting gateway routing and capability merge. Deliberately
 * carries only raw reasoning inputs, never a pre-resolved route or merged
 * `capabilities` object — {@link buildGatewayModelCatalog} is the single
 * place that resolves a route and merges capabilities for a Gateway.
 */
export interface GatewayModelCatalogDynamicRow {
  id: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: readonly string[]
}

/** Inputs required to assemble one gateway-scoped model settings catalog. */
export interface GatewayModelCatalogInput {
  gatewayId: string
  dynamicSource: 'codex' | 'fallback'
  dynamicModels: readonly GatewayModelCatalogDynamicRow[]
  /** Custom Gateway records used by the pure routing boundary. */
  customProviders?: readonly ProviderPreset[]
  hasCredential: boolean
  availabilityByModel: ReadonlyMap<string, AgentModelAvailability>
}

/**
 * Derives a stable revision token from every user-visible catalog field.
 * Only changes when the gateway id or a visible field (display metadata,
 * route, availability, or merged capabilities) changes; ignores list order.
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
        displayName: model.displayName,
        description: model.description,
        hidden: model.hidden,
        isDefault: model.isDefault,
        route: model.route,
        availability: model.availability,
        capabilities: model.capabilities,
      })),
    }))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Resolves a model's route through the sole Gateway routing boundary. It
 * returns `undefined` — instead of throwing — only for the expected case
 * where a dynamic model is not in the fixed `allowedModels` list of its
 * builtin Channel. All other errors, including an unknown Gateway, are
 * rethrown so unexpected routing faults are never silently swallowed.
 */
function tryResolveGatewayModelRoute(
  gatewayId: string,
  modelId: string,
  customProviders: readonly ProviderPreset[],
): AgentModelRoute | undefined {
  try {
    return resolveGatewayModelRoute(gatewayId, modelId, customProviders)
  } catch (error) {
    if (error instanceof ModelUnavailableInGatewayError) return undefined
    throw error
  }
}

function resolveAvailability(
  input: GatewayModelCatalogInput,
  modelId: string,
): AgentModelAvailability {
  return input.hasCredential
    ? input.availabilityByModel.get(modelId) ?? { status: 'available' }
    : { status: 'needs-key', reason: '请先配置网关 Key' }
}

/**
 * Fallback-sourced catalogs (no live Codex confirmation) mark every context
 * option conservative, even ones with a verified policy, since the whole
 * row is speculative rather than Codex-confirmed.
 */
function withConservativeContext(
  capabilities: ModelSettingsCapabilities,
  conservative: boolean,
): ModelSettingsCapabilities {
  if (!conservative) return capabilities
  return {
    ...capabilities,
    contextOptions: capabilities.contextOptions.map((option) => ({
      ...option,
      conservative: true,
    })),
  }
}

/**
 * 选择器的显示顺序 = `CANONICAL_MODEL_SETTINGS_ROWS` 的下标。
 *
 * 在这一步排序之前，顺序是**组装顺序**的副产品：先铺网关 `model/list` 回来的动态
 * 行，再补渠道声明的静态行。后果是一个只存在于静态那一轮的模型（典型如挂在 Miau
 * 上的 qwen —— 它不在 apiyi/rightcode 的 model/list 里）永远被追加到末尾，无论你
 * 在 canonical 数组里把它放到哪。也就是说那个数组的顺序此前是句空话。
 *
 * 排序后它说了算。不在 canonical 里的 slug 排在**最前**而不是最后：它们只可能
 * 来自网关的 `model/list`，也就是上游确认存在的真模型，而 canonical 行是我们自己
 * 的策展。把确认过的压到策展行下面是退步 —— 排前面也正好保住它们在这次改动之前
 * 的位置（此前动态行整体先于静态行）。彼此之间的相对次序由 `sort` 的稳定性保住。
 */
function canonicalOrderIndex(modelId: string): number {
  const index = CANONICAL_MODEL_SETTINGS_ROWS.findIndex((row) => row.id === modelId)
  return index === -1 ? -1 : index
}

function sortByCanonicalOrder(
  models: AgentModelSettingsEntry[],
): AgentModelSettingsEntry[] {
  return models.sort(
    (left, right) => canonicalOrderIndex(left.id) - canonicalOrderIndex(right.id),
  )
}

function staticDisplayMetadata(modelId: string): { displayName: string; description: string } {
  const canonical = CANONICAL_MODEL_SETTINGS_ROWS.find((row) => row.id === modelId)
  return {
    displayName: canonical?.displayName ?? modelId,
    description: canonical?.description ?? 'Responses model',
  }
}

/**
 * Builds one gateway-scoped model catalog by merging dynamic Codex rows
 * with statically declared Channel models, deduplicating by model id, and
 * attaching an authoritative route plus availability for the active
 * Gateway. Route resolution and capability merge each happen exactly once
 * per model, here — callers must never pre-resolve either.
 */
export function buildGatewayModelCatalog(
  input: GatewayModelCatalogInput,
): AgentModelSettingsCatalog {
  const byId = new Map<string, AgentModelSettingsEntry>()
  const declaredModels = channelsForGateway(input.gatewayId)
    .flatMap((channel) => [
      ...(channel.allowedModels ?? []),
      ...(channel.extraCatalogModels ?? []),
    ])
  const conservativeContext = input.dynamicSource === 'fallback'

  for (const row of input.dynamicModels) {
    const route = tryResolveGatewayModelRoute(
      input.gatewayId,
      row.id,
      input.customProviders ?? [],
    )
    if (!route) continue
    byId.set(row.id, {
      id: row.id,
      displayName: row.displayName,
      description: row.description,
      hidden: row.hidden,
      isDefault: row.isDefault,
      family: route.family,
      route,
      availability: resolveAvailability(input, row.id),
      capabilities: withConservativeContext(
        mergeModelSettingsCapabilities({
          model: row.id,
          gatewayId: input.gatewayId,
          channelId: route.channelId,
          defaultReasoningEffort: row.defaultReasoningEffort,
          supportedReasoningEfforts: row.supportedReasoningEfforts,
        }),
        conservativeContext,
      ),
    })
  }

  for (const modelId of declaredModels) {
    if (byId.has(modelId)) continue
    const route = tryResolveGatewayModelRoute(
      input.gatewayId,
      modelId,
      input.customProviders ?? [],
    )
    if (!route) continue
    const { displayName, description } = staticDisplayMetadata(modelId)
    byId.set(modelId, {
      id: modelId,
      displayName,
      description,
      hidden: false,
      isDefault: false,
      family: route.family,
      route,
      availability: resolveAvailability(input, modelId),
      capabilities: withConservativeContext(
        mergeModelSettingsCapabilities({
          model: modelId,
          gatewayId: input.gatewayId,
          channelId: route.channelId,
          supportedReasoningEfforts: [],
        }),
        conservativeContext,
      ),
    })
  }

  const models = sortByCanonicalOrder([...byId.values()])
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
