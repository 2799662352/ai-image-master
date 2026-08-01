import { describe, expect, it } from 'vitest'
import {
  CANONICAL_MODEL_SETTINGS_ROWS,
  EXPERIMENTAL_CONTEXT_WINDOW,
  GROK_4_5_CONTEXT_WINDOW,
  UNKNOWN_MODEL_CONTEXT_WINDOW,
  defaultContextWindowForModel,
  isConcreteModelReasoningEffort,
  isModelContextWindowSupported,
  isModelReasoningEffort,
  mergeModelSettingsCapabilities,
  migrateLegacyModelSelection,
  modelAutoCompactTokenLimit,
  modelContextOptions,
  modelContextPinsEqual,
  resolveModelContextPin,
  supportedReasoningEfforts,
} from '../modelSettings'

describe('model settings capabilities', () => {
  it('publishes provider-neutral Grok 4.5 metadata', () => {
    expect(
      CANONICAL_MODEL_SETTINGS_ROWS.find((row) => row.id === 'grok-4.5'),
    ).toEqual({
      id: 'grok-4.5',
      displayName: 'Grok 4.5',
      tier: 'Extra High',
      description: 'Frontier coding and agentic model with native Responses support.',
      isDefault: false,
    })
  })

  it('uses Gateway + Channel Grok 4.5 context limits', () => {
    expect(defaultContextWindowForModel('grok-4.5')).toBe(GROK_4_5_CONTEXT_WINDOW)
    expect(defaultContextWindowForModel('grok-4.5', 'apiyi', 'apiyi-grok')).toBe(
      GROK_4_5_CONTEXT_WINDOW,
    )
    expect(defaultContextWindowForModel('grok-4.5', 'rightcode', 'rightcode-grok')).toBe(
      EXPERIMENTAL_CONTEXT_WINDOW,
    )
    expect(modelContextOptions('grok-4.5', 'apiyi', 'apiyi-grok')).toContainEqual({
      value: 500_000,
      experimental: false,
    })
    expect(modelContextOptions('grok-4.5', 'rightcode', 'rightcode-grok')).toContainEqual({
      value: 1_000_000,
      experimental: false,
    })
  })

  it('rejects partial gateway scope instead of silently using model-only policy', () => {
    const contextOptions = modelContextOptions as (...args: string[]) => unknown
    const defaultWindow = defaultContextWindowForModel as (...args: string[]) => unknown
    const isSupported = isModelContextWindowSupported as (
      model: string,
      contextWindow: number,
      gatewayId?: string,
    ) => unknown

    expect(() => contextOptions('grok-4.5', 'rightcode')).toThrow(
      'Gateway and channel ids must be provided together',
    )
    expect(() => defaultWindow('grok-4.5', 'rightcode')).toThrow(
      'Gateway and channel ids must be provided together',
    )
    expect(() => isSupported('grok-4.5', 500_000, 'rightcode')).toThrow(
      'Gateway and channel ids must be provided together',
    )
  })

  it.each([
    ['apiyi', 'apiyi-grok', GROK_4_5_CONTEXT_WINDOW],
    ['rightcode', 'rightcode-grok', EXPERIMENTAL_CONTEXT_WINDOW],
  ])('uses verified Grok reasoning capabilities for %s/%s', (
    gatewayId,
    channelId,
    contextWindow,
  ) => {
    expect(
      mergeModelSettingsCapabilities({
        model: 'grok-4.5',
        gatewayId,
        channelId,
      }),
    ).toMatchObject({
      defaultContextWindow: contextWindow,
      contextOptions: [{ value: contextWindow, experimental: false }],
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    })
    expect(
      supportedReasoningEfforts('grok-4.5', gatewayId, channelId),
    ).toEqual(['low', 'medium', 'high'])
  })

  it('keeps max and filters ultra for Right Code gpt-5.6-sol', () => {
    expect(
      mergeModelSettingsCapabilities({
        model: 'gpt-5.6-sol',
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      }),
    ).toEqual({
      model: 'gpt-5.6-sol',
      provider: 'rightcode',
      defaultContextWindow: 272_000,
      contextOptions: [
        { value: 272_000, experimental: false },
        { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
      ],
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('filters max and ultra for Right Code gpt-5.5', () => {
    expect(
      mergeModelSettingsCapabilities({
        model: 'gpt-5.5',
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      }),
    ).toEqual({
      model: 'gpt-5.5',
      provider: 'rightcode',
      defaultContextWindow: 272_000,
      contextOptions: [
        { value: 272_000, experimental: false },
        { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
      ],
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    })
  })

  it('filters max for Right Code gpt-5.5-openai-compact', () => {
    expect(
      mergeModelSettingsCapabilities({
        model: 'gpt-5.5-openai-compact',
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      }).supportedReasoningEfforts,
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('keeps max for gpt-5.5 on non-Right Code providers', () => {
    expect(
      mergeModelSettingsCapabilities({
        model: 'gpt-5.5',
        gatewayId: 'apiyi',
        channelId: 'apiyi-standard',
        supportedReasoningEfforts: ['max', 'ultra'],
      }).supportedReasoningEfforts,
    ).toEqual(['max'])
  })

  it('whitelists and normalises upstream reasoning efforts', () => {
    expect(
      mergeModelSettingsCapabilities({
        model: 'custom-model',
        gatewayId: 'custom',
        channelId: 'custom:custom',
        supportedReasoningEfforts: ['ultra', 'xhigh', 'low', 'low', 'future-level'],
      }).supportedReasoningEfforts,
    ).toEqual(['low', 'xhigh'])
  })

  it.each(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'accepts model reasoning effort %s',
    (effort) => {
      expect(isModelReasoningEffort(effort)).toBe(true)
    },
  )

  it.each(['ultra', 'future-level', '', null, undefined, 1, true])(
    'rejects unsupported model reasoning effort %j',
    (effort) => {
      expect(isModelReasoningEffort(effort)).toBe(false)
    },
  )

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])(
    'accepts concrete model reasoning effort %s',
    (effort) => {
      expect(isConcreteModelReasoningEffort(effort)).toBe(true)
    },
  )

  it.each(['auto', 'ultra', 'future-level', '', null, undefined, 1, true])(
    'rejects non-concrete model reasoning effort %j',
    (effort) => {
      expect(isConcreteModelReasoningEffort(effort)).toBe(false)
    },
  )

  it.each([
    ['grok-4.5', GROK_4_5_CONTEXT_WINDOW],
    ['gpt-5.6-sol', 272_000],
    ['gpt-5.6-terra', 272_000],
    ['gpt-5.6-luna', 272_000],
    ['gpt-5.5', 272_000],
    ['gpt-5.4', 272_000],
    ['gpt-5.4-mini', 272_000],
    ['custom-model', UNKNOWN_MODEL_CONTEXT_WINDOW],
  ])('uses the verified default context for %s', (model, expected) => {
    expect(defaultContextWindowForModel(model)).toBe(expected)
  })

  it.each(['constructor', 'toString', '__proto__'])(
    'treats Object.prototype key %s as an unknown model',
    (model) => {
      expect(defaultContextWindowForModel(model)).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW)
      expect(modelContextOptions(model)).toEqual([
        {
          value: UNKNOWN_MODEL_CONTEXT_WINDOW,
          experimental: false,
          conservative: true,
        },
        { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
      ])
    },
  )

  it.each([
    ['gpt-5.6-sol', 272_000],
    ['gpt-5.6-terra', 272_000],
    ['gpt-5.6-luna', 272_000],
    ['gpt-5.5', 272_000],
    ['gpt-5.4', 272_000],
    ['gpt-5.4-mini', 272_000],
  ])('keeps verified defaults unmarked and adds experimental 1M for %s', (
    model,
    expectedDefault,
  ) => {
    expect(modelContextOptions(model)).toEqual([
      { value: expectedDefault, experimental: false },
      { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
    ])
  })

  it('marks an unknown model context as a conservative default', () => {
    expect(modelContextOptions('custom-model')).toEqual([
      {
        value: UNKNOWN_MODEL_CONTEXT_WINDOW,
        experimental: false,
        conservative: true,
      },
      { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
    ])
  })

  it.each([
    ['gpt-5.4-low', { model: 'gpt-5.4', reasoningEffort: 'low', migrated: true }],
    ['gpt-5.4-medium', { model: 'gpt-5.4', reasoningEffort: 'medium', migrated: true }],
    ['gpt-5.4-high', { model: 'gpt-5.4', reasoningEffort: 'high', migrated: true }],
    ['gpt-5.4-xhigh', { model: 'gpt-5.4', reasoningEffort: 'xhigh', migrated: true }],
    ['gpt-5.5-xhigh', { model: 'gpt-5.5', reasoningEffort: 'xhigh', migrated: true }],
    [
      'vendor-new-model',
      { model: 'vendor-new-model', reasoningEffort: 'auto', migrated: false },
    ],
  ])('migrates picker id %s', (id, expected) => {
    expect(migrateLegacyModelSelection(id)).toEqual(expected)
  })

  it.each(['constructor', 'toString', '__proto__'])(
    'treats Object.prototype key %s as an unknown legacy selection',
    (id) => {
      expect(migrateLegacyModelSelection(id)).toEqual({
        model: id,
        reasoningEffort: 'auto',
        migrated: false,
      })
    },
  )

  it.each([
    [11, 9],
    [200_000, 180_000],
    [272_000, 244_800],
    [372_000, 334_800],
    [1_000_000, 900_000],
  ])('uses a floor 90 percent compact limit for %i', (window, expected) => {
    expect(modelAutoCompactTokenLimit(window)).toBe(expected)
  })
})

describe('model context pin', () => {
  it.each([
    ['gpt-5.5', 272_000],
    ['gpt-5.6-sol', 272_000],
    ['gpt-5.6-terra', 272_000],
    ['gpt-5.6-luna', 272_000],
    ['gpt-5.4', 272_000],
    ['gpt-5.4-mini', 272_000],
    ['gpt-5.2', 272_000],
  ])('does not pin %s at its Codex-native window', (model, native) => {
    expect(resolveModelContextPin(model, native)).toBeNull()
  })

  it('pins a Codex-native model at a non-native window', () => {
    expect(resolveModelContextPin('gpt-5.6-sol', EXPERIMENTAL_CONTEXT_WINDOW)).toEqual({
      modelContextWindow: 1_000_000,
      modelAutoCompactTokenLimit: 900_000,
    })
    expect(resolveModelContextPin('gpt-5.5', EXPERIMENTAL_CONTEXT_WINDOW)).toEqual({
      modelContextWindow: 1_000_000,
      modelAutoCompactTokenLimit: 900_000,
    })
  })

  it('always pins models without Codex-native metadata', () => {
    expect(resolveModelContextPin('grok-4.5', GROK_4_5_CONTEXT_WINDOW)).toEqual({
      modelContextWindow: 500_000,
      modelAutoCompactTokenLimit: 450_000,
    })
    expect(resolveModelContextPin('custom-model', UNKNOWN_MODEL_CONTEXT_WINDOW)).toEqual({
      modelContextWindow: 200_000,
      modelAutoCompactTokenLimit: 180_000,
    })
  })

  it.each(['constructor', 'toString', '__proto__'])(
    'treats Object.prototype key %s as a model without native metadata',
    (model) => {
      expect(resolveModelContextPin(model, 272_000)).toEqual({
        modelContextWindow: 272_000,
        modelAutoCompactTokenLimit: 244_800,
      })
    },
  )

  it('compares pins structurally including the unpinned state', () => {
    expect(modelContextPinsEqual(null, null)).toBe(true)
    expect(modelContextPinsEqual(
      { modelContextWindow: 272_000, modelAutoCompactTokenLimit: 244_800 },
      { modelContextWindow: 272_000, modelAutoCompactTokenLimit: 244_800 },
    )).toBe(true)
    expect(modelContextPinsEqual(
      null,
      { modelContextWindow: 272_000, modelAutoCompactTokenLimit: 244_800 },
    )).toBe(false)
    expect(modelContextPinsEqual(
      { modelContextWindow: 272_000, modelAutoCompactTokenLimit: 244_800 },
      { modelContextWindow: 372_000, modelAutoCompactTokenLimit: 334_800 },
    )).toBe(false)
  })

  it('keeps the 5.5 to 5.6 switch pin-free in both directions', () => {
    expect(modelContextPinsEqual(
      resolveModelContextPin('gpt-5.5', 272_000),
      resolveModelContextPin('gpt-5.6-sol', 272_000),
    )).toBe(true)
  })
})
