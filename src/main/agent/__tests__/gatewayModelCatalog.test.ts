import { describe, expect, it } from 'vitest'
import { mergeModelSettingsCapabilities } from '../../../shared/modelSettings'
import {
  buildGatewayModelCatalog,
  modelCatalogRevision,
  type GatewayModelCatalogDynamicRow,
} from '../gatewayModelCatalog'
import type { AgentModelSettingsEntry } from '../../../types/agent'
import type { ProviderPreset } from '../codexProviders'

function dynamicModel(
  id: string,
  overrides: Partial<GatewayModelCatalogDynamicRow> = {},
): GatewayModelCatalogDynamicRow {
  return {
    id,
    displayName: id,
    description: 'Dynamic model',
    hidden: false,
    isDefault: id === 'gpt-5.5',
    ...overrides,
  }
}

const CUSTOM_PROVIDER: ProviderPreset = {
  id: 'acme-studio',
  name: 'Acme Studio',
  baseUrl: 'https://acme.example/v1',
  envKey: 'OPENAI_API_KEY',
}

describe('buildGatewayModelCatalog', () => {
  it('aggregates standard, Grok and Claude models for Right.Codes', () => {
    // Codex's model/list only knows the standard channel's models, so the
    // single-family channels contribute their declared allowedModels — that is
    // the ONLY way Grok and Claude reach the picker.
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
      'claude-opus-5',
      'claude-sonnet-5',
    ])
    expect(catalog.models.find((model) => model.id === 'grok-4.5')?.route)
      .toMatchObject({ channelId: 'rightcode-grok', family: 'xai' })
    expect(catalog.models.find((model) => model.id === 'claude-opus-5')?.route)
      .toMatchObject({ channelId: 'rightcode-claude', family: 'anthropic' })
  })

  it('offers Claude per gateway according to what that pool truly serves', () => {
    // Same canonical slug, two gateways, deliberately different answers: apiyi
    // echoes back `anthropic/claude-fable-5` and runs it, while rightcode
    // substitutes claude-opus-4-8 for that slug. A row must appear only where
    // it resolves to the model it claims to be.
    const build = (gatewayId: string) => buildGatewayModelCatalog({
      gatewayId,
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5'), dynamicModel('claude-fable-5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(build('apiyi').models.find((model) => model.id === 'claude-fable-5')?.route)
      .toMatchObject({ channelId: 'apiyi-claude', family: 'anthropic' })
    expect(build('rightcode').models.map((model) => model.id))
      .not.toContain('claude-fable-5')
  })

  it('keeps deterministic unauthorized Grok visible', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5')],
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
      dynamicModels: [dynamicModel('grok-4.5', {
        displayName: 'Dynamic Grok',
        description: 'From Codex',
      })],
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
      dynamicModels: [dynamicModel('gpt-5.5')],
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
      dynamicModels: [dynamicModel('gpt-5.5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.source).toBe('fallback')
  })

  it('marks every context option conservative for fallback-sourced rows', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'rightcode',
      dynamicSource: 'fallback',
      dynamicModels: [dynamicModel('grok-4.5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    const grok = catalog.models.find((model) => model.id === 'grok-4.5')
    expect(grok?.capabilities.contextOptions.every((option) => option.conservative === true))
      .toBe(true)
  })

  it('looks up static display metadata from the canonical rows instead of hardcoding it', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.models.find((model) => model.id === 'grok-4.5')).toMatchObject({
      displayName: 'Grok 4.5',
      description: 'Frontier coding and agentic model with native Responses support.',
    })
  })

  it('routes a real custom gateway through its single custom channel', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'acme-studio',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('acme-vision-1')],
      customProviders: [CUSTOM_PROVIDER],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.source).toBe('codex')
    expect(catalog.models).toHaveLength(1)
    expect(catalog.models[0]?.route).toEqual({
      gatewayId: 'acme-studio',
      channelId: 'custom:acme-studio',
      modelId: 'acme-vision-1',
      family: 'other',
    })
  })

  it('rethrows an unknown gateway routing failure', () => {
    expect(() => buildGatewayModelCatalog({
      gatewayId: 'missing-gateway',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('missing-model')],
      customProviders: [],
      hasCredential: true,
      availabilityByModel: new Map(),
    })).toThrow('Unknown Codex gateway "missing-gateway"')
  })

  it('skips an unroutable dynamic row without dropping the rest of the catalog', () => {
    const catalog = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [
        dynamicModel('gpt-5.5'),
        // "grok-3" infers the xai family, but apiyi-grok's Channel only
        // allows grok-4.5 — this row must be skipped, not crash the catalog.
        dynamicModel('grok-3'),
      ],
      hasCredential: true,
      availabilityByModel: new Map(),
    })

    expect(catalog.models.map((model) => model.id).sort()).toEqual([
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'gpt-5.5',
      'grok-4.5',
    ])
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

  it('changes when route, availability, or capabilities change', () => {
    const base = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5')],
      hasCredential: true,
      availabilityByModel: new Map(),
    })
    const unauthorized = buildGatewayModelCatalog({
      gatewayId: 'apiyi',
      dynamicSource: 'codex',
      dynamicModels: [dynamicModel('gpt-5.5')],
      hasCredential: true,
      availabilityByModel: new Map([
        ['grok-4.5', { status: 'unauthorized', reason: 'blocked' }],
      ]),
    })

    const baseModel = base.models.find((model) => model.id === 'gpt-5.5')
    if (!baseModel) throw new Error('Expected gpt-5.5')
    const revisionWith = (model: AgentModelSettingsEntry) =>
      modelCatalogRevision(
        'apiyi',
        base.models.map((candidate) =>
          candidate.id === model.id ? model : candidate),
      )

    expect(base.revision).not.toBe(unauthorized.revision)
    expect(base.revision).not.toBe(revisionWith({
      ...baseModel,
      route: { ...baseModel.route, channelId: 'apiyi-grok' },
    }))
    expect(base.revision).not.toBe(revisionWith({
      ...baseModel,
      availability: { status: 'unauthorized', reason: 'blocked' },
    }))
    expect(base.revision).not.toBe(revisionWith({
      ...baseModel,
      capabilities: {
        ...baseModel.capabilities,
        defaultContextWindow: baseModel.capabilities.defaultContextWindow + 1,
      },
    }))
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

  it('changes when displayName, description, hidden, or isDefault change field-by-field', () => {
    function entry(overrides: Partial<AgentModelSettingsEntry> = {}): AgentModelSettingsEntry {
      return {
        id: 'a',
        displayName: 'A',
        description: 'desc',
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
        ...overrides,
      }
    }

    const base = modelCatalogRevision('apiyi', [entry()])

    expect(modelCatalogRevision('apiyi', [entry({ displayName: 'A2' })])).not.toBe(base)
    expect(modelCatalogRevision('apiyi', [entry({ description: 'desc2' })])).not.toBe(base)
    expect(modelCatalogRevision('apiyi', [entry({ hidden: true })])).not.toBe(base)
    expect(modelCatalogRevision('apiyi', [entry({ isDefault: true })])).not.toBe(base)
  })
})
