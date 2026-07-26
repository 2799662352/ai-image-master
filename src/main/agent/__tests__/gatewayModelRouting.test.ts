import { describe, expect, it } from 'vitest'

import {
  channelsForGateway,
  ModelUnavailableInGatewayError,
  resolveAuthorizedGatewayModelRoute,
  resolveGatewayModelRoute,
  resolveProviderChannel,
} from '../gatewayModelRouting'

describe('gatewayModelRouting', () => {
  it('resolves API Yi GPT models to apiyi-standard', () => {
    expect(resolveGatewayModelRoute('apiyi', 'gpt-5.5')).toEqual({
      gatewayId: 'apiyi',
      channelId: 'apiyi-standard',
      modelId: 'gpt-5.5',
      family: 'openai',
    })
  })

  it('resolves API Yi Grok 4.5 to apiyi-grok', () => {
    expect(resolveGatewayModelRoute('apiyi', 'grok-4.5')).toEqual({
      gatewayId: 'apiyi',
      channelId: 'apiyi-grok',
      modelId: 'grok-4.5',
      family: 'xai',
    })
  })

  it('resolves Right.Codes Grok 4.5 to rightcode-grok', () => {
    const route = resolveGatewayModelRoute('rightcode', 'grok-4.5')
    const channel = resolveProviderChannel(route.channelId)

    expect(route.channelId).toBe('rightcode-grok')
    expect(channel.baseUrl).toBe('https://rightapi.ai/grok/v1')
  })

  it('routes Claude models to the Anthropic-native pool with the bridge on', () => {
    const route = resolveGatewayModelRoute('rightcode', 'claude-opus-5')
    const channel = resolveProviderChannel(route.channelId)

    expect(route).toEqual({
      gatewayId: 'rightcode',
      channelId: 'rightcode-claude',
      modelId: 'claude-opus-5',
      family: 'anthropic',
    })
    // Its own host, not the codex/grok one: this pool speaks Messages only,
    // so it must go through the translating bridge.
    expect(channel.baseUrl).toBe('https://right.codes/claude-sale/v1')
    expect(channel.compatibilityPolicy).toBe('anthropic-messages-bridge')
    expect(channel.supportsMemories).toBe(false)
  })

  it('rejects Claude on gateways with no Anthropic pool as a skippable miss', () => {
    // apiyi has no `-claude` channel. The picker aggregates every canonical
    // row against every gateway, so this has to be the same catchable type as
    // an allowedModels miss — not a hard config error.
    expect(() => resolveGatewayModelRoute('apiyi', 'claude-opus-5'))
      .toThrow(ModelUnavailableInGatewayError)
  })

  it('rejects Claude slugs the pool silently substitutes or 404s', () => {
    // claude-fable-5 answers as claude-opus-4-8 (announced only via a
    // non-standard `{"type":"fallback"}` block no SDK surfaces), and
    // date-suffixed slugs 404. Offering either is worse than not offering it.
    for (const model of ['claude-fable-5', 'claude-opus-5-20260501']) {
      expect(() => resolveGatewayModelRoute('rightcode', model))
        .toThrow(ModelUnavailableInGatewayError)
    }
  })

  it('routes memory side requests to the smartest model each endpoint serves', () => {
    // memories.extract_model / consolidation_model default to gpt-5.4, which
    // grok-only endpoints reject with 400. Both apiyi channels share the full
    // api.apiyi.com endpoint (every model available) so memories can run on
    // the smarter gpt-5.5 — even when chatting on grok. rightcode-standard's
    // channel model IS gpt-5.5 (fallback covers it); rightcode-grok's endpoint
    // serves ONLY grok-4.5, so it must not carry a memoriesModel override.
    expect(resolveProviderChannel('apiyi-standard').memoriesModel).toBe('gpt-5.5')
    expect(resolveProviderChannel('apiyi-grok').memoriesModel).toBe('gpt-5.5')
    expect(resolveProviderChannel('rightcode-standard').model).toBe('gpt-5.5')
    expect(resolveProviderChannel('rightcode-grok').memoriesModel).toBeUndefined()
    expect(resolveProviderChannel('rightcode-grok').model).toBe('grok-4.5')
  })

  it('keeps builtin gateway cards separate from internal channels', () => {
    expect(channelsForGateway('apiyi').map((channel) => channel.id)).toEqual([
      'apiyi-standard',
      'apiyi-grok',
    ])
  })

  it('routes catalog-authorized custom gateways through one custom channel', () => {
    expect(resolveAuthorizedGatewayModelRoute({
      source: 'model-catalog',
      gatewayId: 'custom-studio',
    }, 'vendor-future-model')).toEqual({
      gatewayId: 'custom-studio',
      channelId: 'custom:custom-studio',
      modelId: 'vendor-future-model',
      family: 'other',
    })
  })

  it('does not treat an ordinary builtin gateway typo as custom', () => {
    expect(() => resolveAuthorizedGatewayModelRoute({
      source: 'builtin',
      gatewayId: 'rightcodes',
    }, 'grok-4.5')).toThrow('Unknown Codex gateway "rightcodes"')
  })
})
