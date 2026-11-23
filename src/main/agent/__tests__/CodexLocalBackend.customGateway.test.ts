import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「自定义网关」在 Codex 这一路的两个落点(CodexLocalBackend 里两个纯函数):
 *
 *  1. `withDevGatewayOverride`:Miau 通道的 baseUrl 换成用户填的地址(其余通道不碰),
 *     且**优先于**开发期环境变量覆盖;
 *  2. `gatewayPlatformHeadersFor`:自定义网关生效时一律不贴平台影子 token / 归属头 ——
 *     包括用户把地址填成官方域名的情形(他明确选了「用自己的 Key」)。
 *
 * 第二条是计费安全边界:这两个函数的出口就是 Codex 兼容代理出网前的最后一道换头。
 */

vi.mock('electron', () => ({ app: { isPackaged: false } }))

vi.mock('../../services/auth/gatewayToken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/gatewayToken')>()
  return {
    ...actual,
    getActivePoolToken: () => 'shadow-token',
    gatewayPlatformHeaders: (token: string) => ({
      Authorization: `Bearer ${token}`,
      'X-Platform-User-Id': 'u-1',
      'X-Project-Id': '7',
    }),
  }
})

import { gatewayPlatformHeadersFor, withDevGatewayOverride } from '../CodexLocalBackend'
import type { CodexProviderConfig } from '../codexLaunch'
import { MIAU_BASE_URL } from '../../../shared/miau'
import {
  __resetCustomGatewayForTests,
  applyCustomGatewayState,
} from '../../services/customGateway'
import { resolveGatewayOrigin } from '../../services/auth/gatewayHeaderInjector'

const ENV = 'CATIMATION_GATEWAY_ORIGIN'
const originalEnv = process.env[ENV]

function provider(id: string, baseUrl: string): CodexProviderConfig {
  return { id, name: id, baseUrl, envKey: 'MIAU_API_KEY' }
}

beforeEach(() => {
  __resetCustomGatewayForTests()
  delete process.env[ENV]
})

afterEach(() => {
  __resetCustomGatewayForTests()
  if (originalEnv === undefined) delete process.env[ENV]
  else process.env[ENV] = originalEnv
})

describe('withDevGatewayOverride —— 自定义网关', () => {
  const providers = [
    provider('apiyi-qwen', MIAU_BASE_URL),
    provider('rightcode-gemini', MIAU_BASE_URL),
    provider('apiyi-standard', 'https://api.apiyi.com/v1'),
  ]

  it('没启用:地址原样(返回新数组,不是同一个)', () => {
    const out = withDevGatewayOverride(providers)
    expect(out.map((p) => p.baseUrl)).toEqual(providers.map((p) => p.baseUrl))
    expect(out).not.toBe(providers)
  })

  it('启用:所有 Miau 通道换成「自定义地址/v1」,别家的通道不碰', () => {
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })

    const out = withDevGatewayOverride(providers)

    expect(out[0].baseUrl).toBe('https://gw.example.com/v1')
    expect(out[1].baseUrl).toBe('https://gw.example.com/v1')
    expect(out[2].baseUrl).toBe('https://api.apiyi.com/v1')
  })

  it('启用:带子路径的地址原样保留', () => {
    applyCustomGatewayState({ active: true, url: 'https://x.example.com/newapi' })
    expect(withDevGatewayOverride(providers)[0].baseUrl).toBe('https://x.example.com/newapi/v1')
  })

  it('启用:不改入参,其余字段(envKey / model)原样带过去', () => {
    applyCustomGatewayState({ active: true, url: 'http://10.0.0.5:3000' })
    const input = [{ ...provider('apiyi-qwen', MIAU_BASE_URL), model: 'qwen4-max' }]

    const out = withDevGatewayOverride(input)

    expect(input[0].baseUrl).toBe(MIAU_BASE_URL)
    expect(out[0]).toMatchObject({ baseUrl: 'http://10.0.0.5:3000/v1', envKey: 'MIAU_API_KEY', model: 'qwen4-max' })
  })

  it('关掉之后立刻恢复(状态读的是实时值)', () => {
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    applyCustomGatewayState({ active: false, url: '' })
    expect(withDevGatewayOverride(providers)[0].baseUrl).toBe(MIAU_BASE_URL)
  })

  it('优先于开发期环境变量覆盖(用户显式选的比环境变量更具体)', () => {
    process.env[ENV] = 'http://127.0.0.1:4000'
    // 对照:没启用时开发构建认环境变量。
    expect(withDevGatewayOverride(providers)[0].baseUrl).toBe('http://127.0.0.1:4000/v1')

    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    expect(withDevGatewayOverride(providers)[0].baseUrl).toBe('https://gw.example.com/v1')
  })
})

describe('gatewayPlatformHeadersFor —— 平台头不跟去自定义网关', () => {
  const official = () => new URL(resolveGatewayOrigin())

  it('对照:没启用、目标是官方网关 → 贴平台头(Authorization + 归属)', () => {
    const headers = gatewayPlatformHeadersFor(official())
    expect(headers).toMatchObject({
      Authorization: 'Bearer shadow-token',
      'X-Platform-User-Id': 'u-1',
      'X-Project-Id': '7',
    })
  })

  it('对照:没启用、目标不是官方网关 → 不贴', () => {
    expect(gatewayPlatformHeadersFor(new URL('https://gw.example.com'))).toBeNull()
  })

  it('启用:目标是用户的地址 → 不贴', () => {
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    expect(gatewayPlatformHeadersFor(new URL('https://gw.example.com'))).toBeNull()
  })

  it('启用:用户把地址填成官方域名 → 仍然不贴(他明确选了自己的 Key)', () => {
    applyCustomGatewayState({ active: true, url: resolveGatewayOrigin() })
    expect(gatewayPlatformHeadersFor(official())).toBeNull()
  })

  it('启用时即使目标恰是官方网关(别的通道直连它)也不贴,关掉后恢复', () => {
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    expect(gatewayPlatformHeadersFor(official())).toBeNull()

    applyCustomGatewayState({ active: false, url: '' })
    expect(gatewayPlatformHeadersFor(official())).not.toBeNull()
  })
})
