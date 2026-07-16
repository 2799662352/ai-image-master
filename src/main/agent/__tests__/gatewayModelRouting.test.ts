import { describe, expect, it } from 'vitest'

import {
  channelsForGateway,
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
    expect(channel.baseUrl).toBe('https://right.codes/grok/v1')
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
