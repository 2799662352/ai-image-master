// 音频生成(seed-audio-1.0)走平台余额。
//
// 症状:用户已登录、计费来源是「平台余额」,出图 / 理解都能用,唯独 `generate_audio`
// 和「音频生成」页报「请先设置 API Key」。病根是 `ApiService.generateAudio` 在发请求前
// 无条件要求本站点有自填 Key,没有给平台余额留豁免 —— 请求根本到不了网关,
// 主进程的注入器(`gatewayHeaderInjector`)也就没机会换上平台凭据。
//
// 这里断三件事:
//  1. 平台模式 + Miau 网关:没有自填 Key 也要放行,且只打标记头、不发 Authorization;
//  2. 平台模式下用户另填过 Key 也不能把它发出去(否则注入失效时会静默走自己的钱);
//  3. 豁免只覆盖 Miau 网关 —— 自有 Key 模式、或指向别的站点时,没 Key 仍要拦下。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BILLING_MARKER_HEADER, BILLING_MARKER_VALUE } from '../../../../../types/authApi'

const MIAU_SPEECH_URL = 'https://miauapi.13797248455.xyz/v1/audio/speech'

type BillingSource = 'platform' | 'own-key'

async function makeService(billingSource: BillingSource) {
  // ApiService 经 getState() 读 billingSource;resetModules 之后这里 import 到的
  // store 与 ApiService 拿到的是同一个实例(见 ApiService.platformBilling.test.ts)。
  const { useQuotaStore } = await import('../../../stores/useQuotaStore')
  useQuotaStore.setState({ billingSource })
  const mod = await import('../ApiService')
  return { service: new mod.ApiService(), SEED_AUDIO_SITE_KEY: mod.SEED_AUDIO_SITE_KEY }
}

describe('ApiService.generateAudio · 平台余额', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ audio: 'QUJD', duration: 3.2, original_duration: 3.4, format: 'mp3' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('平台模式且没填自填 Key:放行,只打标记头、不发 Authorization', async () => {
    const { service, SEED_AUDIO_SITE_KEY } = await makeService('platform')

    const result = await service.generateAudio({ input: '你好', siteKey: SEED_AUDIO_SITE_KEY })

    expect(result.success).toBe(true)
    expect(result.audioBase64).toBe('QUJD')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(MIAU_SPEECH_URL)
    const headers = init.headers as Record<string, string>
    expect(headers[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
    expect(headers.Authorization).toBeUndefined()
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['Accept']).toBe('application/json')
  })

  it('平台模式下当前站点不是 Miau 也放行(siteKey 钉死在 Miau)', async () => {
    localStorage.setItem('current_site', 'apiyi')
    const { service, SEED_AUDIO_SITE_KEY } = await makeService('platform')

    const result = await service.generateAudio({ input: '你好', siteKey: SEED_AUDIO_SITE_KEY })

    expect(result.success).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(MIAU_SPEECH_URL)
    expect((init.headers as Record<string, string>)[BILLING_MARKER_HEADER]).toBe(
      BILLING_MARKER_VALUE,
    )
  })

  it('平台模式下用户另填过 Key 也不发出去(防止注入失效时静默走自己的钱)', async () => {
    localStorage.setItem('api_key_antigravity', 'user-typed-key')
    const { service, SEED_AUDIO_SITE_KEY } = await makeService('platform')

    await service.generateAudio({ input: '你好', siteKey: SEED_AUDIO_SITE_KEY })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
    expect(headers.Authorization).toBeUndefined()
  })

  it('自有 Key 模式且没填 Key:仍然拦下,不发请求', async () => {
    const { service, SEED_AUDIO_SITE_KEY } = await makeService('own-key')

    const result = await service.generateAudio({ input: '你好', siteKey: SEED_AUDIO_SITE_KEY })

    expect(result.success).toBe(false)
    expect(result.error).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('自有 Key 模式且填了 Key:照旧发 Authorization,不打标记', async () => {
    localStorage.setItem('api_key_antigravity', 'user-typed-key')
    const { service, SEED_AUDIO_SITE_KEY } = await makeService('own-key')

    const result = await service.generateAudio({ input: '你好', siteKey: SEED_AUDIO_SITE_KEY })

    expect(result.success).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer user-typed-key')
    expect(headers[BILLING_MARKER_HEADER]).toBeUndefined()
  })

  // 平台余额只覆盖 Miau 网关。指向别的站点(apiyi / 自建)时,标记头换不到凭据,
  // 放行了只会 401 —— 所以那里没 Key 仍要在本地拦下,给用户一句人话。
  it('平台模式但请求指向非 Miau 站点且没 Key:仍然拦下', async () => {
    const { service } = await makeService('platform')

    const result = await service.generateAudio({ input: '你好', siteKey: 'apiyi' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
