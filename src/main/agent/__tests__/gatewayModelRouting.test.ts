import { describe, expect, it } from 'vitest'

import {
  BUILTIN_CHANNELS,
  channelsForGateway,
  ModelUnavailableInGatewayError,
  resolveAuthorizedGatewayModelRoute,
  resolveGatewayModelRoute,
  resolveProviderChannel,
} from '../gatewayModelRouting'
import { MIAU_BASE_URL } from '../../../shared/miau'

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

  it('DeepSeek 只剩 Miau 一条通道:Right.Codes /deepseek 通道与撤下的 slug 在两个网关上都无处可去', () => {
    // `rightcode-deepseek`(Right.Codes /deepseek,只卖 deepseek-v4-flash)已整条撤下。
    // 通道没了,通道 id 就不能再被解析 —— 老数据里若还留着它,要在读取时迁走,
    // 不能指望这里宽容。
    expect(() => resolveProviderChannel('rightcode-deepseek'))
      .toThrow('Unknown provider channel')
    // 撤下的 slug 必须是「本网关无此模型」这种可跳过的错误,而不是落到 /codex
    // (那里没有 DeepSeek,每轮 404)。目录构建靠它筛掉不可路由的行。
    for (const gatewayId of ['apiyi', 'rightcode']) {
      for (const slug of [
        'deepseek-v4-flash',
        'deepseek-v4-flash-0731',
        'deepseek-v4-pro-0813',
        'deepseek-chat',
      ]) {
        expect(
          () => resolveGatewayModelRoute(gatewayId, slug),
          `${gatewayId} / ${slug}`,
        ).toThrow(ModelUnavailableInGatewayError)
      }
    }
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

  /**
   * 记忆任务的模型**不许留给回落**,除非该通道内没有价差。
   *
   * ## 为什么这条值一个专门的测试
   *
   * `memoriesModel` 不声明时回落到 `provider.model` —— 而那不是通道声明的默认值,
   * 是 **codex 上次 spawn 那一刻用户选中的模型**。`memories.extract_model` 是启动时
   * 用 `-c` 写死的,此后在选择器里换模型只改对话那一路(同通道、同上下文窗口不触发
   * 重启),这两条纹丝不动。
   *
   * 2026-08-31 真机撞到:用户切到 qwen3.8-flash 聊天,流水里却是 21 次 qwen3.8-max
   * 共 ¥2.14,Flash 只花了 ¥0.10。形状很好认 —— 对话请求输入 3~5 万 token,
   * 记忆请求只有 7 千,一次接一次。而 UI 上他选的明明是 Flash,这笔钱**无从解释**。
   *
   * ## 判据
   *
   * 只要通道的 `allowedModels` 里不止一个模型,就必须显式声明 `memoriesModel`
   * (或用 `supportsMemories: false` 整个关掉)。豁免要写明为什么没有价差。
   */
  it('多模型通道必须显式钉住记忆模型,不能留给回落', () => {
    // 豁免:两个 slug 卖同一个价(见 rightcode-grok 的 allowedModels 注释),
    // 所以跟着谁跑都一样,不构成「看不出来的花费」。
    const NO_PRICE_SPREAD = new Set(['rightcode-grok'])

    // 直接遍历 `BUILTIN_CHANNELS` 而不是绕网关:这条不变量是**通道级**的,
    // 而同一条通道会挂在两个网关下(qwen 就是),绕网关会把它数两遍。
    const offenders = BUILTIN_CHANNELS.filter(
      (channel) =>
        (channel.allowedModels?.length ?? 0) >= 2 &&
        channel.supportsMemories !== false &&
        !NO_PRICE_SPREAD.has(channel.id) &&
        !channel.memoriesModel,
    ).map((channel) => channel.id)

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `这些通道可选多个模型却没钉住记忆模型:\n` +
          `${offenders.map((c) => `  - ${c}`).join('\n')}\n` +
          `不钉的话记忆会跑在「上次 spawn 时选中的模型」上,换模型也不会变 ——\n` +
          `用户看到一笔他解释不了的消费。声明 memoriesModel,或在 NO_PRICE_SPREAD 里\n` +
          `写明为什么这个通道内没有价差。`,
    ).toEqual([])
  })

  // 曾经这里还有第二条守卫:「钉住的记忆模型必须在本通道的 allowedModels 里」。
  // **那条前提是错的,已删。** `allowedModels` 约束的是**选择器能选什么**,不是
  // **端点能服务什么** —— apiyi-grok 的 baseUrl 是 apiyi 全量端点,只是把对话模型
  // 钉在了 grok,所以它钉 gpt-5.5 做记忆完全合法。真要守「钉的 slug 上游确实有」,
  // 只能靠对着端点跑一次,静态断言做不到。

  it('keeps builtin gateway cards separate from internal channels', () => {
    expect(channelsForGateway('apiyi').map((channel) => channel.id)).toEqual([
      'apiyi-standard',
      'apiyi-grok',
      'apiyi-claude',
      'apiyi-qwen',
      'apiyi-deepseek-miau',
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

  describe('Miau 上的 DeepSeek', () => {
    // 官方渠道两个 + 火山方舟两个(DeepSeek-V4.1-Flash 标准版 / 经济版)。
    const MIAU_DEEPSEEK_SLUGS = [
      'deepseek-flash',
      'deepseek-v4-pro',
      'deepseek-v4-1-flash-261017',
      'deepseek-v4-1-flash-economy-261017',
    ]

    it('四个 slug 在两个网关下都落各自的 Miau 通道', () => {
      for (const gatewayId of ['apiyi', 'rightcode']) {
        for (const slug of MIAU_DEEPSEEK_SLUGS) {
          expect(resolveGatewayModelRoute(gatewayId, slug), `${gatewayId} / ${slug}`)
            .toEqual({
              gatewayId,
              channelId: `${gatewayId}-deepseek-miau`,
              modelId: slug,
              family: 'deepseek',
            })
        }
      }
    })

    it('火山方舟两个模型与 deepseek-flash 走同一条通道,调用方法逐项一致', () => {
      // 用户要求:火山 DeepSeek 的调用方法要和 deepseek-flash(Miau)一致。
      // 「一致」落到代码上就是同一条通道:同一个 Miau baseUrl、同一枚 Miau token、
      // 同一套 Responses 命名空间桥。若有人给火山单开一条通道,这里会红 ——
      // 那就意味着调用路径已经分叉,需要有人明确地决定它。
      for (const gatewayId of ['apiyi', 'rightcode']) {
        const reference = resolveGatewayModelRoute(gatewayId, 'deepseek-flash')
        for (const slug of [
          'deepseek-v4-1-flash-261017',
          'deepseek-v4-1-flash-economy-261017',
        ]) {
          const route = resolveGatewayModelRoute(gatewayId, slug)
          expect(route.channelId, `${gatewayId} / ${slug}`).toBe(reference.channelId)
          const channel = resolveProviderChannel(route.channelId)
          expect(channel.baseUrl).toBe(MIAU_BASE_URL)
          expect(channel.credentialId).toBe('qwen')
          expect(channel.compatibilityPolicy).toBe('responses-namespace-bridge')
          expect(channel.allowedModels).toContain(slug)
        }
      }
    })

    it('通道默认模型是 deepseek-flash(与记忆模型同一档,最便宜)', () => {
      // 原来默认是 deepseek-v4-flash-0731,该 slug 已撤下;留着会让「从没选过
      // 模型的用户」落到一个选择器里不存在的默认值。
      for (const gatewayId of ['apiyi', 'rightcode']) {
        expect(resolveProviderChannel(`${gatewayId}-deepseek-miau`).model)
          .toBe('deepseek-flash')
      }
    })

    it('两条 Miau DeepSeek 通道都打 Miau,因此自动吃平台余额', () => {
      // 平台扣费的判定在 `CodexLocalBackend.gatewayPlatformHeadersFor` 里是**纯按
      // origin** 的:打的是 Miau 就带计费头。所以这里只需守住 baseUrl —— 一旦有人
      // 把它改成别家的地址,平台余额会静默失效(退回自填 Key),而 UI 上看不出来。
      for (const gatewayId of ['apiyi', 'rightcode']) {
        const channel = resolveProviderChannel(`${gatewayId}-deepseek-miau`)
        expect(channel.baseUrl).toBe(MIAU_BASE_URL)
        // 复用 Miau token 那个槽位:用户加 DeepSeek 不必重新配置凭据。
        expect(channel.credentialId).toBe('qwen')
      }
    })

    it('记忆任务钉在便宜档,不跟随选中的对话模型', () => {
      // 不钉的话它回落到 `provider.model`,也就是**上次 spawn 那一刻**选中的模型。
      // 2026-08-31 qwen 通道真机撞过:用户选 Flash 聊天,记忆却跑在 max 上,
      // ¥2.14 vs ¥0.10,而 UI 上完全看不出这笔钱哪来的。
      for (const gatewayId of ['apiyi', 'rightcode']) {
        expect(resolveProviderChannel(`${gatewayId}-deepseek-miau`).memoriesModel)
          .toBe('deepseek-flash')
      }
    })

    /**
     * 「slug 精确命中优先」这条规则要成立,前提是**一个 slug 在一个网关下只被一条
     * 通道认领**。两条抢同一个 slug 的话,先命中谁取决于 `BUILTIN_CHANNELS` 的
     * 数组顺序 —— 那是个没人会想到去查的静默故障:模型能用,只是钱走错了钱包、
     * 明细挂在别的通道下。
     *
     * 所以在这里钉死,而不是靠「我刚才看过一遍,没有重复」。
     */
    it('同一网关下没有两条通道抢同一个 slug', () => {
      const seen = new Map<string, string>()
      for (const channel of BUILTIN_CHANNELS) {
        for (const model of channel.allowedModels ?? []) {
          const key = `${channel.gatewayId}:${model}`
          const previous = seen.get(key)
          expect(
            previous,
            `${key} 同时被 ${previous} 和 ${channel.id} 认领 —— 先命中谁取决于数组顺序`,
          ).toBeUndefined()
          seen.set(key, channel.id)
        }
      }
    })
  })
})
