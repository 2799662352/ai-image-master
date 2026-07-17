import { describe, expect, it } from 'vitest'
import { mergeModelSettingsCapabilities } from '../../../shared/modelSettings'
import {
  buildGatewayModelCatalog,
  modelCatalogRevision,
} from '../gatewayModelCatalog'
import type { AgentModelSettingsEntry } from '../../../types/agent'

function dynamicModel(
  id: string,
  gatewayId = 'rightcode',
  channelId = 'rightcode-standard',
) {
  return {
    id,
    displayName: id,
    description: 'Dynamic model',
    hidden: false,
    isDefault: id === 'gpt-5.5',
    capabilities: mergeModelSettingsCapabilities({
      model: id,
      gatewayId,
      channelId,
      supportedReasoningEfforts: [],
    }),
  }
}

describe('buildGatewayModelCatalog', () => {
  it('aggregates standard and Grok models for Right.Codes', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'rightcode',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.models.map((model) => model.id)).toEqual([
      'gpt-5.5',
      'grok-4.5',
    ])
    expect(catalog.models.find((model) => model.id === 'grok-4.5')?.route)
      .toMatchObject({ channelId: 'rightcode-grok', family: 'xai' })
  })

  it('keeps deterministic unauthorized Grok visible', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5', 'apiyi', 'apiyi-standard')],
      hasCredential: true,
      availabilityByModel: new Map([
        ['grok-4.5', { status: 'unauthorized', reason: '当前 Key 未开通' }],
      ]),
    })

    expect(catalog.models.find((model) => model.id === 'grok-4.5')?.availability)
      .toEqual({ status: 'unauthorized', reason: '当前 Key 未开通' })
  })

  it('deduplicates the same model id and keeps dynamic display fields', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'rightcode',
      dynamicSource: 'codex',
      dynamicModels: [{
        ...dynamicModel('grok-4.5', 'rightcode', 'rightcode-grok'),
        displayName: 'Dynamic Grok',
        description: 'From Codex',
      }],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.models.filter((model) => model.id === 'grok-4.5')).toHaveLength(1)
    expect(catalog.models.find((model) => model.id === 'grok-4.5')).toMatchObject({
      displayName: 'Dynamic Grok',
      description: 'From Codex',
      route: { channelId: 'rightcode-grok', family: 'xai' },
    })
  })

  it('marks every model needs-key when credentials are missing', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5', 'apiyi', 'apiyi-standard')],
      hasCredential: false,
      availabilityByModel: new Map(),
    })

    expect(catalog.models.every((model) => model.availability.status === 'needs-key'))
      .toBe(true)
  })

  it('uses mixed source when static declared models augment Codex rows', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'rightcode',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.source).toBe('mixed')
  })

  it('uses fallback source when dynamicSource is fallback', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'fallback',
      dynamicModels: [dynamicModel('gpt-5.5', 'apiyi', 'apiyi-standard')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.source).toBe('fallback')
  })
})

describe('modelCatalogRevision', () => {
  it('is stable for the same visible catalog content', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'rightcode',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })
    const again = buildGatewayModelCatalog({
      gatewayId: 'rightcode',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.revision).toBe(again.revision)
    expect(catalog.revision).toBe(modelCatalogRevision('rightcode', catalog.models))
  })

  it('changes when route or availability changes', () => {
    const base = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5', 'apiyi', 'apiyi-standard')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })
    const unauthorized = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5', 'apiyi', 'apiyi-standard')],
      hasCredential: true,
      availabilityByModel: new Map([
        ['grok-4.5', { status: 'unauthorized', reason: 'blocked' }],
      ]),
    })

    expect(base.revision).not.toBe(unauthorized.revision)
  })

  it('ignores model list order', () => {
    const left: AgentModelSettingsEntry[] = [
      {
        id: 'a',
        displayName: 'A',
        description: '',
        hidden: false,
        isDefault: false,
        family: 'openai',
        route: {
          gatewayId: 'apiyi',
          channelId: 'apiyi-standard',
          modelId: 'a',
          family: 'openai',
        },
        availability: { status: 'available' },
        capabilities: mergeModelSettingsCapabilities({
          model: 'a',
          gatewayId: 'apiyi',
          channelId: 'apiyi-standard',
          supportedReasoningEfforts: [],
        }),
      },
      {
        id: 'b',
        displayName: 'B',
        description: '',
        hidden: false,
        isDefault: false,
        family: 'openai',
        route: {
          gatewayId: 'apiyi',
          channelId: 'apiyi-standard',
          modelId: 'b',
          family: 'openai',
        },
        availability: { status: 'available' },
        capabilities: mergeModelSettingsCapabilities({
          model: 'b',
          gatewayId: 'apiyi',
          channelId: 'apiyi-standard',
          supportedReasoningEfforts: [],
        }),
      },
    ]

    expect(modelCatalogRevision('apiyi', left))
      .toBe(modelCatalogRevision('apiyi', [...left].reverse()))
  })
})
