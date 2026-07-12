import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_PRESETS,
  DEFAULT_PROVIDER_ID,
  RETIRED_RIGHTCODE_PRO_ID,
  findProviderById,
  isBuiltinProviderId,
  type ProviderPreset,
} from '../codexProviders'

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
    // From https://docs.right.codes/docs/rc_cli_config/codex.html
    expect(rc!.baseUrl).toBe('https://right.codes/codex/v1')
    expect(rc!.envKey).toBe('OPENAI_API_KEY')
    // gpt-5.2 was retired upstream (site announcement 2026-06-02); the docs
    // example now pins gpt-5.5.
    expect(rc!.model).toBe('gpt-5.5')
    expect(rc).not.toHaveProperty('reasoningEffort')
    expect(rc!.verbosity).toBe('high')
    expect(rc!.description).toBe('Pro号池 0.4x · cache_read 1/10 输入价')
    expect(rc!.requiresOpenaiAuth).toBe(true)
    expect(rc!.extraTopLevelConfig?.disable_response_storage).toBe(true)
    expect(rc!.extraTopLevelConfig?.windows_wsl_setup_acknowledged).toBe(true)
  })

  it('builtin presets are readonly (frozen)', () => {
    expect(Object.isFrozen(BUILTIN_PROVIDER_PRESETS)).toBe(true)
    for (const p of BUILTIN_PROVIDER_PRESETS) expect(Object.isFrozen(p)).toBe(true)
  })

  it('no longer ships the retired rightcode-pro preset (/codex-pro 404s since 2026-06-12)', () => {
    // Right.Codes merged /codex-pro into /codex on 2026-06-12 (site
    // announcement); the /codex-pro/v1 route now returns a route-level 404,
    // so shipping the preset would give users a provider that can never talk.
    expect(BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'rightcode-pro')).toBeUndefined()
    expect(RETIRED_RIGHTCODE_PRO_ID).toBe('rightcode-pro')
  })

  it('isBuiltinProviderId discriminates builtins from custom ids', () => {
    expect(isBuiltinProviderId('apiyi')).toBe(true)
    expect(isBuiltinProviderId('rightcode')).toBe(true)
    expect(isBuiltinProviderId('rightcode-pro')).toBe(false)
    expect(isBuiltinProviderId('custom-1234')).toBe(false)
    expect(isBuiltinProviderId('')).toBe(false)
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
    expect(findProviderById('rightcode', custom)?.id).toBe('rightcode')
    expect(findProviderById('custom-1', custom)?.id).toBe('custom-1')
    expect(findProviderById('does-not-exist', custom)).toBeUndefined()
  })

  it('preset ids never collide between builtins and a hypothetical custom list', () => {
    const builtinIds = new Set(BUILTIN_PROVIDER_PRESETS.map((p) => p.id))
    expect(builtinIds.size).toBe(BUILTIN_PROVIDER_PRESETS.length)
    expect(builtinIds.has('apiyi')).toBe(true)
    expect(builtinIds.has('rightcode')).toBe(true)
    expect(builtinIds.has('custom-1')).toBe(false)
  })
})
