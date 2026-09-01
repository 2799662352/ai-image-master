import { describe, expect, it } from 'vitest'
import {
  BUILTIN_CHANNEL_PRESETS,
  BUILTIN_GATEWAY_PRESETS,
  BUILTIN_PROVIDER_PRESETS,
  DEFAULT_PROVIDER_ID,
  RETIRED_RIGHTCODE_PRO_ID,
  credentialIdForProvider,
  findProviderById,
  isBuiltinProviderId,
  isReservedProviderId,
  resolveActiveProvider,
  type ProviderPreset,
} from '../codexProviders'
import { channelsForGateway, resolveProviderChannel } from '../gatewayModelRouting'

describe('codexProviders', () => {
  it('exposes apiyi as the default builtin so existing setups keep working', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('apiyi')
    const apiyi = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'apiyi')
    expect(apiyi).toBeDefined()
    expect(apiyi!.baseUrl).toBe('https://api.apiyi.com/v1')
    expect(apiyi!.envKey).toBe('OPENAI_API_KEY')
  })

  it('ships rightcode preset matching the public docs', () => {
    const rc = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'rightcode')
    expect(rc).toBeDefined()
    expect(rc!.baseUrl).toBe('https://rightapi.ai/codex/v1')
    expect(rc!.envKey).toBe('OPENAI_API_KEY')
    expect(rc!.model).toBe('gpt-5.5')
    expect(rc).not.toHaveProperty('reasoningEffort')
    expect(rc!.verbosity).toBe('high')
    expect(rc!.description).toBe('Pro号池 0.4x · cache_read 1/10 输入价')
    expect(rc!.requiresOpenaiAuth).toBe(true)
    expect(rc!.extraTopLevelConfig?.disable_response_storage).toBe(true)
    expect(rc!.extraTopLevelConfig?.windows_wsl_setup_acknowledged).toBe(true)
  })

  it('does not expose Grok channels in the user-facing builtin provider list', () => {
    expect(BUILTIN_PROVIDER_PRESETS.map((p) => p.id)).toEqual(['apiyi', 'rightcode'])
    expect(BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'apiyi-grok')).toBeUndefined()
    expect(BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'rightcode-grok')).toBeUndefined()
  })

  it('exports the internal channel presets including Grok and Claude routes', () => {
    expect(BUILTIN_CHANNEL_PRESETS.map((channel) => channel.id)).toEqual([
      'apiyi-standard',
      'apiyi-grok',
      'rightcode-standard',
      'rightcode-grok',
      'rightcode-deepseek',
      'rightcode-claude',
      'apiyi-claude',
      // 同一个 Miau 端点在两个网关下各注册一次（过渡态，见 QWEN_CHANNELS 注释）。
      'apiyi-qwen',
      'rightcode-qwen',
      // Miau 上的 DeepSeek，同样两个网关各一次。与 `rightcode-deepseek` 并存
      // 而非替换：slug 不同（带日期 vs 不带），路由靠这个差别把两条分开。
      'apiyi-deepseek-miau',
      'rightcode-deepseek-miau',
    ])

    const claude = resolveProviderChannel('rightcode-claude')
    expect(claude).toMatchObject({
      name: 'Right.Codes Claude',
      // Its own Anthropic-native host, not the codex/grok one.
      baseUrl: 'https://rightapi.ai/claude-sale/v1',
      envKey: 'OPENAI_API_KEY',
      model: 'claude-opus-5',
      allowedModels: ['claude-opus-5', 'claude-sonnet-5'],
      requiresOpenaiAuth: true,
      compatibilityPolicy: 'anthropic-messages-bridge',
      supportsMemories: false,
    })
    // A Claude-only endpoint 404s every GPT slug, so there is no smarter
    // model to point memory side requests at — the feature is off instead.
    expect(claude).not.toHaveProperty('memoriesModel')

    // The other Claude channel is the same protocol with every cost/capability
    // decision inverted, because the pool behind it behaves differently.
    const apiyiClaude = resolveProviderChannel('apiyi-claude')
    expect(apiyiClaude).toMatchObject({
      name: 'API Yi Claude',
      // Shares the host with the gpt/grok channels rather than a dedicated pool.
      baseUrl: 'https://api.apiyi.com/v1',
      model: 'claude-opus-5',
      // Fable is real here; on rightcode the same slug answers as opus-4-8.
      allowedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5'],
      compatibilityPolicy: 'anthropic-messages-bridge',
      // Reads land on this pool, so breakpoints pay for themselves.
      promptCacheBreakpoints: true,
      // gpt-5.5 answers on the same endpoint, so memory artifacts stay valid.
      memoriesModel: 'gpt-5.5',
    })
    expect(apiyiClaude).not.toHaveProperty('supportsMemories')

    expect(resolveProviderChannel('rightcode-standard')).toMatchObject({
      model: 'gpt-5.5',
      extraCatalogModels: ['gpt-5.5-openai-compact'],
    })

    const grok = resolveProviderChannel('rightcode-grok')
    expect(grok).toMatchObject({
      name: 'Right.Codes Grok',
      baseUrl: 'https://rightapi.ai/grok/v1',
      envKey: 'OPENAI_API_KEY',
      // Two slugs, one endpoint. The pinned default stays 4.5 so nobody who
      // never picked a model gets silently moved; 4.6 is opt-in from the picker.
      model: 'grok-4.5',
      allowedModels: ['grok-4.6', 'grok-4.5'],
      requiresOpenaiAuth: true,
    })
    expect(grok).not.toHaveProperty('reasoningEffort')
    expect(grok).not.toHaveProperty('verbosity')

    const deepseek = resolveProviderChannel('rightcode-deepseek')
    expect(deepseek).toMatchObject({
      name: 'Right.Codes DeepSeek',
      baseUrl: 'https://rightapi.ai/deepseek/v1',
      envKey: 'OPENAI_API_KEY',
      // Flash is the official default chat; Pro is opt-in from the picker.
      model: 'deepseek-v4-flash',
      allowedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      requiresOpenaiAuth: true,
      compatibilityPolicy: 'responses-namespace-bridge',
    })
    // 见 gatewayModelRouting 里那条注释:留空不等于「跟随对话模型」,而是跟随
    // **上次 spawn 那一刻**选中的模型 —— 那笔钱用户在 UI 上看不出来。
    expect(deepseek.memoriesModel).toBe('deepseek-v4-flash')

    const apiyiGrok = resolveProviderChannel('apiyi-grok')
    expect(apiyiGrok).toMatchObject({
      name: 'API Yi Grok',
      baseUrl: 'https://api.apiyi.com/v1',
      envKey: 'OPENAI_API_KEY',
      model: 'grok-4.5',
      allowedModels: ['grok-4.5'],
      compatibilityPolicy: 'responses-namespace-bridge',
    })
    expect(apiyiGrok).not.toHaveProperty('reasoningEffort')
    expect(apiyiGrok).not.toHaveProperty('verbosity')
    expect(apiyiGrok).not.toHaveProperty('requiresOpenaiAuth')
  })

  it('exports two gateway presets with channel membership', () => {
    expect(BUILTIN_GATEWAY_PRESETS.map((gateway) => gateway.id)).toEqual([
      'apiyi',
      'rightcode',
    ])
    expect(channelsForGateway('rightcode').map((channel) => channel.id)).toEqual([
      'rightcode-standard',
      'rightcode-grok',
      'rightcode-deepseek',
      'rightcode-claude',
      'rightcode-qwen',
      'rightcode-deepseek-miau',
    ])
  })

  it('builtin presets are readonly (frozen)', () => {
    expect(Object.isFrozen(BUILTIN_PROVIDER_PRESETS)).toBe(true)
    for (const p of BUILTIN_PROVIDER_PRESETS) expect(Object.isFrozen(p)).toBe(true)
    expect(Object.isFrozen(BUILTIN_CHANNEL_PRESETS)).toBe(true)
    expect(Object.isFrozen(BUILTIN_GATEWAY_PRESETS)).toBe(true)
  })

  it('no longer ships the retired rightcode-pro preset (/codex-pro 404s since 2026-06-12)', () => {
    expect(BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'rightcode-pro')).toBeUndefined()
    expect(RETIRED_RIGHTCODE_PRO_ID).toBe('rightcode-pro')
  })

  it('isBuiltinProviderId discriminates gateway builtins from custom ids', () => {
    expect(isBuiltinProviderId('apiyi')).toBe(true)
    expect(isBuiltinProviderId('apiyi-grok')).toBe(false)
    expect(isBuiltinProviderId('rightcode')).toBe(true)
    expect(isBuiltinProviderId('rightcode-grok')).toBe(false)
    expect(isBuiltinProviderId('rightcode-pro')).toBe(false)
    expect(isBuiltinProviderId('custom-1234')).toBe(false)
    expect(isBuiltinProviderId('')).toBe(false)
  })

  it('reserves gateway and internal channel ids without exposing channels as builtins', () => {
    expect(isReservedProviderId('apiyi')).toBe(true)
    expect(isReservedProviderId('rightcode')).toBe(true)
    expect(isReservedProviderId('apiyi-standard')).toBe(true)
    expect(isReservedProviderId('apiyi-grok')).toBe(true)
    expect(isReservedProviderId('rightcode-standard')).toBe(true)
    expect(isReservedProviderId('rightcode-grok')).toBe(true)
    expect(isReservedProviderId('custom-1')).toBe(false)
    expect(isBuiltinProviderId('apiyi-grok')).toBe(false)
    expect(BUILTIN_PROVIDER_PRESETS).toHaveLength(2)
  })

  it('bridges legacy channel ids without exposing them as builtin cards', () => {
    expect(credentialIdForProvider('apiyi-grok')).toBe('apiyi')
    expect(credentialIdForProvider('rightcode-grok')).toBe('rightcode')
    expect(resolveActiveProvider('apiyi-grok')).toMatchObject({
      id: 'apiyi-grok',
      credentialId: 'apiyi',
      compatibilityPolicy: 'responses-namespace-bridge',
    })
    expect(resolveActiveProvider('rightcode-grok')).toMatchObject({
      id: 'rightcode-grok',
      credentialId: 'rightcode',
    })
    expect(BUILTIN_PROVIDER_PRESETS).toHaveLength(2)
  })

  it('findProviderById prefers exact matches across presets and custom list', () => {
    const custom: ProviderPreset[] = [
      {
        id: 'custom-1',
        name: 'My Gateway',
        baseUrl: 'https://gw.example.com/v1',
        envKey: 'OPENAI_API_KEY',
        isCustom: true,
      },
    ]
    expect(findProviderById('apiyi', custom)?.id).toBe('apiyi')
    expect(findProviderById('apiyi-grok', custom)).toBeUndefined()
    expect(findProviderById('rightcode', custom)?.id).toBe('rightcode')
    expect(findProviderById('rightcode-grok', custom)).toBeUndefined()
    expect(findProviderById('custom-1', custom)?.id).toBe('custom-1')
    expect(findProviderById('does-not-exist', custom)).toBeUndefined()
  })

  it('preset ids never collide between builtins and a hypothetical custom list', () => {
    const builtinIds = new Set(BUILTIN_PROVIDER_PRESETS.map((p) => p.id))
    expect(builtinIds.size).toBe(BUILTIN_PROVIDER_PRESETS.length)
    expect(builtinIds.has('apiyi')).toBe(true)
    expect(builtinIds.has('rightcode')).toBe(true)
    expect(builtinIds.has('apiyi-grok')).toBe(false)
    expect(builtinIds.has('rightcode-grok')).toBe(false)
    expect(builtinIds.has('custom-1')).toBe(false)
  })
})
