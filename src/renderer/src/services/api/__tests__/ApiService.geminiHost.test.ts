import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 谷歌原生端点跟其它模型一样走站点的加速域名。
 *
 * 2026-07-28 曾实测 EdgeOne 对 `/v1beta/models/...:generateContent` 一律 524,于是这类
 * 模型被改道到明文源站 `http://175.178.198.17:3000`。代价是它们既用不了平台余额
 * (注入器只认加速域名),自填 Key 也在明文信道上传。2026-09-30 复测:经加速域名
 * Nano Banana 2 1K 17 s、Nano Banana Pro 4K 42.6 s(响应 9 MB base64)均 200,
 * 改道随之取消。别再加回明文源站 —— 若 EdgeOne 再出 524,先查它的回源超时。
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

describe('谷歌原生端点的 host', () => {
  it('Miau 站点上走加速域名(https),路径保持谷歌原生格式', async () => {
    const service = await makeService()

    for (const model of ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image']) {
      const url = new URL(urlFor(service, model, 'antigravity'))
      expect(url.origin, model).toBe('https://miauapi.13797248455.xyz')
      expect(url.pathname).toBe(`/v1beta/models/${model}:generateContent`)
    }
  })

  it('其它站点照旧跟随站点 host', async () => {
    const service = await makeService()

    const url = new URL(urlFor(service, 'gemini-3-pro-image', 'apiyi'))
    expect(url.host).toBe('api.apiyi.com')
  })

  it('任何模型都不会打到明文源站', async () => {
    const service = await makeService()
    const s = service as unknown as { models: Record<string, unknown> }

    for (const model of Object.keys(s.models)) {
      expect(urlFor(service, model, 'antigravity'), model).not.toContain('175.178.198.17')
    }
  })
})
