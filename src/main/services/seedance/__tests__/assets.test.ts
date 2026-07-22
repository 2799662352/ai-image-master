import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

const fetchMock = vi.fn()

vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}))

import {
  signAssetRequest,
  importSeedanceAsset,
  listSeedanceAssets,
  getSeedanceAssetCapacity,
  deleteSeedanceAssets,
} from '../assets'
import { setSeedanceRegionMemory } from '../region'

const CREDS = { apiKey: 'sd_key', apiSecret: 'sd_secret' }

const ASSET = {
  id: 'dla-1',
  kind: 'image',
  imageCategory: 'image_people',
  name: '参考1.jpg',
  previewUrl: 'https://cdn.example/p.jpg',
  assetUrl: 'asset://v0c001',
  assetId: 'v0c001',
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  setSeedanceRegionMemory('global')
  delete process.env.SEEDANCE_BASE_URL
})

describe('signAssetRequest', () => {
  it('按 method\\npath\\ntimestamp\\nsha256(body) 计算 HMAC-SHA256', () => {
    const bodyText = '{"kind":"image"}'
    const { timestamp, signature } = signAssetRequest(
      'POST',
      '/api/open/v1/local-assets',
      bodyText,
      'secret-1',
      '1780000000000',
    )
    expect(timestamp).toBe('1780000000000')
    const bodySha = crypto.createHash('sha256').update(bodyText).digest('hex')
    const canonical = ['POST', '/api/open/v1/local-assets', '1780000000000', bodySha].join('\n')
    const expected = crypto.createHmac('sha256', 'secret-1').update(canonical).digest('hex')
    expect(signature).toBe(expected)
  })

  it('GET 请求对空 body 签名', () => {
    const a = signAssetRequest('GET', '/api/open/v1/local-assets', '', 'secret-1', '1')
    const b = signAssetRequest('GET', '/api/open/v1/local-assets', '', 'secret-1', '1')
    expect(a.signature).toBe(b.signature)
  })
})

describe('importSeedanceAsset', () => {
  it('POST 带 X-API-Key/X-Timestamp/X-Signature 头并返回 asset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ duplicated: false, asset: ASSET }, 201))
    const result = await importSeedanceAsset(
      { kind: 'image', imageCategory: 'image_people', url: 'data:image/png;base64,xx' },
      CREDS,
    )
    expect(result.duplicated).toBe(false)
    expect(result.asset.assetUrl).toBe('asset://v0c001')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://vvdance.ai/api/open/v1/local-assets')
    const headers = init.headers as Record<string, string>
    expect(headers['X-API-Key']).toBe('sd_key')
    expect(headers['X-Timestamp']).toMatch(/^\d+$/)
    expect(headers['X-Signature']).toMatch(/^[0-9a-f]{64}$/)
    expect(init.method).toBe('POST')
  })

  it('重复素材返回 duplicated=true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ duplicated: true, asset: ASSET }))
    const result = await importSeedanceAsset({ kind: 'image', url: 'https://x/y.png' }, CREDS)
    expect(result.duplicated).toBe(true)
  })

  it('缺少 Secret 时直接报错（不发请求）', async () => {
    await expect(
      importSeedanceAsset({ kind: 'image', url: 'https://x/y.png' }, { apiKey: 'k', apiSecret: '' }),
    ).rejects.toThrow(/Secret/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('上游错误透出 message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'quota exceeded' }, 429))
    await expect(
      importSeedanceAsset({ kind: 'image', url: 'https://x/y.png' }, CREDS),
    ).rejects.toThrow(/429.*quota exceeded/)
  })

  it('兼容 data 包裹一层的响应', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, data: { asset: ASSET } }, 201))
    const result = await importSeedanceAsset({ kind: 'image', url: 'https://x/y.png' }, CREDS)
    expect(result.asset.assetId).toBe('v0c001')
  })

  it('兼容 asset 字段平铺在 data 里的响应', async () => {
    const { assetUrl: _omit, ...withoutUrl } = ASSET
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: withoutUrl }, 201))
    const result = await importSeedanceAsset({ kind: 'image', url: 'https://x/y.png' }, CREDS)
    // assetUrl 缺失时由 assetId 拼出
    expect(result.asset.assetUrl).toBe('asset://v0c001')
  })

  it('解析失败时错误信息带响应片段便于排查', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, weird: 'shape' }, 201))
    await expect(
      importSeedanceAsset({ kind: 'image', url: 'https://x/y.png' }, CREDS),
    ).rejects.toThrow(/missing assetId.*weird/)
  })
})

describe('listSeedanceAssets', () => {
  it('query 拼到 URL,签名只签路径', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [ASSET], total: 1, page: 2, pageSize: 24, totalPages: 3 }),
    )
    const result = await listSeedanceAssets({ page: 2, pageSize: 24, kind: 'image_people', q: '参考' }, CREDS)
    expect(result.items).toHaveLength(1)
    expect(result.totalPages).toBe(3)
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('?page=2&pageSize=24')
    expect(url).toContain('kind=image_people')
  })

  it('缺字段时回退默认值', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}))
    const result = await listSeedanceAssets({}, CREDS)
    expect(result.items).toEqual([])
    expect(result.page).toBe(1)
    expect(result.totalPages).toBe(1)
  })

  it('兼容 data 包裹一层的列表响应', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 0, data: { items: [ASSET], total: 1, page: 1, pageSize: 24, totalPages: 1 } }),
    )
    const result = await listSeedanceAssets({}, CREDS)
    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(1)
  })
})

describe('getSeedanceAssetCapacity', () => {
  it('GET /capacity，签名签到含 /capacity 的子路径', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ used: 1, limit: 100, remaining: 99 }))
    const result = await getSeedanceAssetCapacity(CREDS)
    expect(result).toEqual({ used: 1, limit: 100, remaining: 99 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://vvdance.ai/api/open/v1/local-assets/capacity')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    const headers = init.headers as Record<string, string>
    // 子路径必须进签名：用同一时间戳重算，证明签的是 .../local-assets/capacity 而非裸路径。
    const ts = headers['X-Timestamp']
    const expected = signAssetRequest('GET', '/api/open/v1/local-assets/capacity', '', 'sd_secret', ts)
    expect(headers['X-Signature']).toBe(expected.signature)
    const wrong = signAssetRequest('GET', '/api/open/v1/local-assets', '', 'sd_secret', ts)
    expect(headers['X-Signature']).not.toBe(wrong.signature)
  })

  it('兼容 data 包裹并对缺字段回退 0', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { used: 5 } }))
    const result = await getSeedanceAssetCapacity(CREDS)
    expect(result).toEqual({ used: 5, limit: 0, remaining: 0 })
  })
})

describe('deleteSeedanceAssets', () => {
  it('DELETE 把 assetIds 放进 body 并对该 body 签名', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        deletedCount: 1,
        items: [{ assetId: 'v0c001', name: '参考1.jpg', deletedAt: '2026-06-09T08:15:30.000Z' }],
        summary: { used: 0, limit: 100, remaining: 100 },
      }),
    )
    const result = await deleteSeedanceAssets(['v0c001'], CREDS)
    expect(result.deletedCount).toBe(1)
    expect(result.items[0].assetId).toBe('v0c001')
    expect(result.summary?.remaining).toBe(100)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://vvdance.ai/api/open/v1/local-assets')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBe(JSON.stringify({ assetIds: ['v0c001'] }))
    const headers = init.headers as Record<string, string>
    const ts = headers['X-Timestamp']
    const expected = signAssetRequest(
      'DELETE',
      '/api/open/v1/local-assets',
      JSON.stringify({ assetIds: ['v0c001'] }),
      'sd_secret',
      ts,
    )
    expect(headers['X-Signature']).toBe(expected.signature)
  })

  it('空 assetIds 直接报错（不发请求）', async () => {
    await expect(deleteSeedanceAssets([], CREDS)).rejects.toThrow(/至少一个 assetId/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('超过 100 个直接报错（不发请求）', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `id-${i}`)
    await expect(deleteSeedanceAssets(many, CREDS)).rejects.toThrow(/最多删除 100/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('缺 deletedCount 时按 items 长度兜底', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          items: [
            { assetId: 'a', name: 'a', deletedAt: 't' },
            { assetId: 'b', name: 'b', deletedAt: 't' },
          ],
        },
      }),
    )
    const result = await deleteSeedanceAssets(['a', 'b'], CREDS)
    expect(result.deletedCount).toBe(2)
  })
})
