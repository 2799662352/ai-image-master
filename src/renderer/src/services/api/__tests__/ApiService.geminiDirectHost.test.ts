import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 谷歌原生端点必须绕开加速域名，直连源站。
 *
 * 实测(2026-07-28)：Miau 的加速域名前面挂着 EdgeOne，而 EdgeOne **不支持**
 * `/v1beta/models/...:generateContent` 这条谷歌路径 —— 请求一律以 524 收场，
 * 而 524 错误页不带 CORS 头，于是浏览器把它报成「No 'Access-Control-Allow-Origin'」，
 * 掩盖了真实原因。
 *
 * 只有这一类模型受影响，因为它们和别人不是一回事：响应把整张图以 base64 内联
 * 回传(数 MB)，其余模型只回一条短 URL。
 *
 * 判据用 `apiType === 'gemini-native'` 而不是逐个模型打标记 —— 将来加新的谷歌
 * 模型时不需要有人记得这件事。
 */

async function makeService() {
  const { ApiService } = await import('../ApiService')
  return new ApiService()
}

/** 直接问 buildRequestUrl(私有,测试里按行为断言最直接)。 */
function urlFor(service: unknown, modelKey: string, siteKey: string): string {
  const s = service as {
    models: Record<string, unknown>
    apiSites: Record<string, unknown>
    buildRequestUrl(model: unknown, site: unknown): string
  }
  return s.buildRequestUrl(s.models[modelKey], s.apiSites[siteKey])
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('谷歌原生端点绕开 CDN', () => {
  it('gemini-native 模型走源站,不走加速域名', async () => {
    const service = await makeService()

    for (const model of ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image']) {
      const url = urlFor(service, model, 'antigravity')
      expect(url, `${model} 不该走加速域名`).not.toContain('miauapi.13797248455.xyz')
      expect(url).toContain('/v1beta/models/')
    }
  })

  it('其余模型照旧跟随站点(享受加速)', async () => {
    const service = await makeService()

    const url = urlFor(service, 'wan2.7-image-pro', 'antigravity')
    expect(url).toContain('miauapi.13797248455.xyz')
  })

  it('站点没配源站地址时不做任何特殊处理(不硬编码兜底)', async () => {
    const service = await makeService()
    const s = service as unknown as {
      models: Record<string, unknown>
      apiSites: Record<string, Record<string, unknown>>
      buildRequestUrl(model: unknown, site: unknown): string
    }
    const siteWithoutDirect = { ...s.apiSites['antigravity'], directBaseURL: undefined }

    const url = s.buildRequestUrl(s.models['gemini-3.1-flash-image'], siteWithoutDirect)

    expect(url).toContain('miauapi.13797248455.xyz')
  })
})
