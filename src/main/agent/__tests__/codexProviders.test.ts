import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_PRESETS,
  DEFAULT_PROVIDER_ID,
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
    expect(rc!.model).toBe('gpt-5.2')
    expect(rc!.reasoningEffort).toBe('xhigh')
    expect(rc!.verbosity).toBe('high')
    expect(rc!.requiresOpenaiAuth).toBe(true)
    expect(rc!.extraTopLevelConfig?.disable_response_storage).toBe(true)
    expect(rc!.extraTopLevelConfig?.windows_wsl_setup_acknowledged).toBe(true)
  })

  it('builtin presets are readonly (frozen)', () => {
    expect(Object.isFrozen(BUILTIN_PROVIDER_PRESETS)).toBe(true)
    for (const p of BUILTIN_PROVIDER_PRESETS) expect(Object.isFrozen(p)).toBe(true)
  })

  it('ships rightcode-pro fallback at /codex-pro for high-stability workloads', () => {
    const pro = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'rightcode-pro')
    expect(pro).toBeDefined()
    expect(pro!.baseUrl).toBe('https://right.codes/codex-pro/v1')
    expect(pro!.model).toBe('gpt-5.2')
    expect(pro!.reasoningEffort).toBe('xhigh')
    expect(pro!.requiresOpenaiAuth).toBe(true)
    // Same caching semantics as the cheaper rightcode tier; the difference is
    // billing multiplier (0.4x vs 0.2x) and stability — encoded in the
    // human-facing description, not the runtime config.
  })

  it('isBuiltinProviderId discriminates builtins from custom ids', () => {
    expect(isBuiltinProviderId('apiyi')).toBe(true)
    expect(isBuiltinProviderId('rightcode')).toBe(true)
    expect(isBuiltinProviderId('rightcode-pro')).toBe(true)
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
