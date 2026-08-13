import { describe, expect, it } from 'vitest'

import {
  BUILTIN_CHANNELS,
  channelsForGateway,
  ModelUnavailableInGatewayError,
  resolveAuthorizedGatewayModelRoute,
  resolveGatewayModelRoute,
  resolveProviderChannel,
} from '../gatewayModelRouting'

describe('gatewayModelRouting', () => {
  /**
   * 曾经这两条是 'none'，因为「Miau 的 Responses 转发是完整的」——那个结论只拿
   * 对话验过。文本、reasoning、usage 确实都回来了，但 codex 把 MCP 工具包成
   * `{"type":"namespace"}`（OpenAI 私有扩展），网关静默丢弃后照常返回 200，
   * 模型压根看不见工具，于是刷出一串 `unsupported call: `（openai/codex#23186）。
   *
   * 这条测试钉住的是「别再改回 none」。要改回去，先跑一次真实的工具调用往返。
   */
  it('千问通道必须走 namespace 桥 —— 不桥则工具被静默丢弃', () => {
    for (const gateway of ['apiyi', 'rightcode'] as const) {
      const channel = channelsForGateway(gateway).find((c) => c.id === `${gateway}-qwen`)
      expect(channel, `${gateway}-qwen 通道应存在`).toBeDefined()
      expect(channel!.compatibilityPolicy).toBe('responses-namespace-bridge')
      // qwen3.8-max 是撞上这个 bug 的那一个，确保它确实在这条通道里。
      expect(channel!.allowedModels).toContain('qwen3.8-max')
    }
  })

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

  it('serves Grok 4.6 on Right.Codes only, and never on a gateway that lacks it', () => {
    expect(resolveGatewayModelRoute('rightcode', 'grok-4.6')).toEqual({
      gatewayId: 'rightcode',
      channelId: 'rightcode-grok',
      modelId: 'grok-4.6',
      family: 'xai',
    })
    // API Yi has not been confirmed to sell the slug. Routing it there anyway
    // would trade a picker row the user cannot use for a 404 on every turn.
    expect(() => resolveGatewayModelRoute('apiyi', 'grok-4.6'))
      .toThrow(ModelUnavailableInGatewayError)
  })

  it('serves DeepSeek V4 on Right.Codes /deepseek only, never on API Yi or /codex', () => {
    expect(resolveGatewayModelRoute('rightcode', 'deepseek-v4-flash')).toEqual({
      gatewayId: 'rightcode',
      channelId: 'rightcode-deepseek',
      modelId: 'deepseek-v4-flash',
      family: 'deepseek',
    })
    expect(resolveGatewayModelRoute('rightcode', 'deepseek-v4-pro')).toEqual({
      gatewayId: 'rightcode',
      channelId: 'rightcode-deepseek',
      modelId: 'deepseek-v4-pro',
      family: 'deepseek',
    })
    const channel = resolveProviderChannel('rightcode-deepseek')
    expect(channel.baseUrl).toBe('https://rightapi.ai/deepseek/v1')
    expect(channel.model).toBe('deepseek-v4-flash')
    expect(channel.allowedModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(channel.compatibilityPolicy).toBe('responses-namespace-bridge')
    expect(channel.memoriesModel).toBeUndefined()
    // API Yi has no DeepSeek pool. Routing there would put a picker row
    // that 404s every turn. Unlisted slugs on the Right.Codes pool are
    // refused the same way — they must not fall through to /codex.
    expect(() => resolveGatewayModelRoute('apiyi', 'deepseek-v4-pro'))
      .toThrow(ModelUnavailableInGatewayError)
    expect(() => resolveGatewayModelRoute('rightcode', 'deepseek-chat'))
      .toThrow(ModelUnavailableInGatewayError)
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
    // Same host as codex/grok, its own path: this pool speaks Messages only,
    // so it must go through the translating bridge.
    expect(channel.baseUrl).toBe('https://rightapi.ai/claude-sale/v1')
    expect(channel.compatibilityPolicy).toBe('anthropic-messages-bridge')
    expect(channel.supportsMemories).toBe(false)
  })

  it('keeps every builtin channel off the host the vendor says is blocked', () => {
    // Not hypothetical. v4.4.10 moved the codex and grok channels off
    // `right.codes` after the vendor announced it blocked on mainland
    // networks; two days later the new Claude channel shipped pointing right
    // back at it (v4.4.12), and v4.4.13 had to move it again. A blocked host
    // does not refuse — it hangs — so the symptom was a turn that never
    // answered and never errored, and a probe from a machine with a VPN on
    // reports it healthy. Only a check that reads the config can catch it.
    const offenders = BUILTIN_CHANNELS
      .filter((channel) => channel.baseUrl.includes('right.codes'))
      .map((channel) => `${channel.id} → ${channel.baseUrl}`)

    expect(offenders).toEqual([])
  })

  it('routes Claude to each gateway\'s own Anthropic channel', () => {
    // Both builtin gateways serve Claude, but from different pools, so the
    // channel — not just the family — has to follow the gateway.
    expect(resolveGatewayModelRoute('apiyi', 'claude-opus-5'))
      .toMatchObject({ channelId: 'apiyi-claude', family: 'anthropic' })
    expect(resolveGatewayModelRoute('rightcode', 'claude-opus-5'))
      .toMatchObject({ channelId: 'rightcode-claude', family: 'anthropic' })
  })

  it('rejects Claude slugs the chosen pool does not truly serve', () => {
    // The picker aggregates every canonical row against every gateway, so an
    // unserved slug has to raise the catchable skip type rather than a hard
    // config error. Same slug, opposite verdicts by gateway: rightcode answers
    // claude-fable-5 as claude-opus-4-8 (announced only through a non-standard
    // `{"type":"fallback"}` block no SDK surfaces) while apiyi echoes back
    // `anthropic/claude-fable-5` and genuinely runs it. Date-suffixed slugs 404
    // on both.
    expect(() => resolveGatewayModelRoute('rightcode', 'claude-fable-5'))
      .toThrow(ModelUnavailableInGatewayError)
    expect(resolveGatewayModelRoute('apiyi', 'claude-fable-5'))
      .toMatchObject({ channelId: 'apiyi-claude' })
    for (const gatewayId of ['apiyi', 'rightcode']) {
      expect(() => resolveGatewayModelRoute(gatewayId, 'claude-opus-5-20260501'))
        .toThrow(ModelUnavailableInGatewayError)
    }
  })

  it('routes memory side requests to the smartest model each endpoint serves', () => {
    // memories.extract_model / consolidation_model default to gpt-5.4, which
    // grok-only endpoints reject with 400. Both apiyi channels share the full
    // api.apiyi.com endpoint (every model available) so memories can run on
    // the smarter gpt-5.5 — even when chatting on grok. rightcode-standard's
    // channel model IS gpt-5.5 (fallback covers it); rightcode-grok's endpoint
    // serves the grok family only, so it must not carry a memoriesModel
    // override — a GPT slug there is a 400, whichever Grok is chatting.
    expect(resolveProviderChannel('apiyi-standard').memoriesModel).toBe('gpt-5.5')
    expect(resolveProviderChannel('apiyi-grok').memoriesModel).toBe('gpt-5.5')
    expect(resolveProviderChannel('rightcode-standard').model).toBe('gpt-5.5')
    expect(resolveProviderChannel('rightcode-standard').extraCatalogModels)
      .toEqual(['gpt-5.5-openai-compact'])
    expect(resolveGatewayModelRoute('rightcode', 'gpt-5.5-openai-compact')).toEqual({
      gatewayId: 'rightcode',
      channelId: 'rightcode-standard',
      modelId: 'gpt-5.5-openai-compact',
      family: 'openai',
    })
    expect(resolveProviderChannel('rightcode-grok').memoriesModel).toBeUndefined()
    expect(resolveProviderChannel('rightcode-grok').model).toBe('grok-4.5')
  })

  it('keeps builtin gateway cards separate from internal channels', () => {
    expect(channelsForGateway('apiyi').map((channel) => channel.id)).toEqual([
      'apiyi-standard',
      'apiyi-grok',
      'apiyi-claude',
      'apiyi-qwen',
    ])
  })

  it('把 qwen 送到 Miau 渠道，而不是网关自家的 standard', () => {
    // qwen 若并进 `other`，会落到 standard 渠道 —— 那是网关自己的端点，用的也是
    // 网关自己的 Key，请求必然 404/401。所以它必须自成一族。
    for (const gatewayId of ['apiyi', 'rightcode']) {
      expect(resolveGatewayModelRoute(gatewayId, 'qwen3.8-max'))
        .toMatchObject({ channelId: `${gatewayId}-qwen`, family: 'qwen' })
      expect(resolveGatewayModelRoute(gatewayId, 'qwen3.7-max-dashscope'))
        .toMatchObject({ channelId: `${gatewayId}-qwen`, family: 'qwen' })
    }
    // 不在白名单里的 qwen 变体照样被拒，而不是悄悄落到别的渠道。
    expect(() => resolveGatewayModelRoute('apiyi', 'qwen-bogus-9'))
      .toThrow(ModelUnavailableInGatewayError)
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
