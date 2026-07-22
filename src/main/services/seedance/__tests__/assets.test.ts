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
  verifyContentAssetReferences,
  translateSeedanceTaskError,
} from '../assets'
import { setSeedanceRegionMemory } from '../region'
import type { SeedanceContentItem } from '../types'

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

  it('兼容 data 被二次字符串化的响应（明明成功不该报失败）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: JSON.stringify({ duplicated: true, asset: ASSET }) }, 201),
    )
    const result = await importSeedanceAsset({ kind: 'image', url: 'https://x/y.png' }, CREDS)
    expect(result.asset.assetId).toBe('v0c001')
    expect(result.duplicated).toBe(true)
  })

  // 2026-07-22 线上实测:导入响应的 asset 只回内部行 id(dla-xxx),没有可引用的
  // assetId/assetUrl。dla 形态直接拿去创建任务会被上游 400 LOCAL_ASSET_NOT_FOUND
  // 拒掉,所以导入后必须追加一次 list,用 id 匹配出真实 assetId/assetUrl。
  const ID_ONLY_IMPORT_RESPONSE = {
    success: true,
    data: {
      duplicated: false,
      asset: {
        id: 'dla-mrwc058u-e8mr7x',
        developerId: 'cmrolxpd904z7y7mb3m7resh0',
        kind: 'image',
        createdBy: 'openapi_asset_import',
        imageCategory: 'image_people',
        name: '0EE9F213.png',
        previewUrl: null,
      },
    },
  }

  it('导入响应仅回 id 时,追加 list 二次解析出真实 assetId/assetUrl', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ID_ONLY_IMPORT_RESPONSE, 201))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { ...ASSET, id: 'dla-other', assetId: 'v0c000', assetUrl: 'asset://v0c000' },
          {
            id: 'dla-mrwc058u-e8mr7x',
            kind: 'image',
            imageCategory: 'image_people',
            name: '0EE9F213.png',
            previewUrl: 'https://cdn.example/preview.png',
            assetId: 'v0c777',
            assetUrl: 'asset://v0c777',
          },
        ],
        total: 2,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      }),
    )
    const result = await importSeedanceAsset(
      { kind: 'image', imageCategory: 'image_people', url: 'data:image/png;base64,xx' },
      CREDS,
    )
    expect(result.asset.assetId).toBe('v0c777')
    expect(result.asset.assetUrl).toBe('asset://v0c777')
    expect(result.duplicated).toBe(false)
    expect(result.referenceable).toBe(true)
    // 第二次调用是按 input.kind 过滤的大页 list
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [listUrl, listInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(listInit.method).toBe('GET')
    expect(listUrl).toContain('pageSize=50')
    expect(listUrl).toContain('kind=image_people')
  })

  it('list 里也找不到匹配 id 时保留 id 兜底并标记不可引用(不阻断导入)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ID_ONLY_IMPORT_RESPONSE, 201))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [ASSET], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
    )
    const result = await importSeedanceAsset({ kind: 'image', url: 'data:image/png;base64,xx' }, CREDS)
    expect(result.asset.assetId).toBe('dla-mrwc058u-e8mr7x')
    expect(result.asset.assetUrl).toBe('asset://dla-mrwc058u-e8mr7x')
    // 不可引用:调用方(runtime)应保留 https 直传,不能换成 asset://dla-xxx
    expect(result.referenceable).toBe(false)
  })

  it('id 匹配不到但 name 命中时用 name 解析出真 assetId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ID_ONLY_IMPORT_RESPONSE, 201))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          // list 条目 id 与导入行 id 不同(上游两侧 id 空间不一致),但名字一致
          { id: 'row-999', kind: 'image', name: '0EE9F213.png', assetId: 'v0c888', assetUrl: 'asset://v0c888' },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      }),
    )
    const result = await importSeedanceAsset(
      { kind: 'image', url: 'data:image/png;base64,xx', name: '0EE9F213.png' },
      CREDS,
    )
    expect(result.asset.assetId).toBe('v0c888')
    expect(result.referenceable).toBe(true)
  })

  it('追加 list 请求失败时保留 id 兜底并标记不可引用(不阻断导入)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ID_ONLY_IMPORT_RESPONSE, 201))
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
    const result = await importSeedanceAsset({ kind: 'image', url: 'data:image/png;base64,xx' }, CREDS)
    expect(result.asset.assetId).toBe('dla-mrwc058u-e8mr7x')
    expect(result.asset.assetUrl).toBe('asset://dla-mrwc058u-e8mr7x')
    expect(result.referenceable).toBe(false)
  })

  it('响应带真实 assetId 时不追加 list 调用', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ duplicated: false, asset: ASSET }, 201))
    const result = await importSeedanceAsset({ kind: 'image', url: 'https://x/y.png' }, CREDS)
    expect(result.asset.assetId).toBe('v0c001')
    expect(result.referenceable).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

describe('verifyContentAssetReferences', () => {
  const contentWith = (...urls: string[]): SeedanceContentItem[] => [
    { type: 'text', text: 'prompt' },
    ...urls.map((url): SeedanceContentItem => ({ type: 'image_url', image_url: { url } })),
  ]

  it('引用在列表里(按 assetId 命中)则通过', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [ASSET], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
    )
    await expect(
      verifyContentAssetReferences(contentWith('asset://v0c001'), CREDS),
    ).resolves.toBeUndefined()
  })

  it('引用命中条目的内部 id 也算存在(宽容,避免误拦)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [ASSET], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
    )
    await expect(
      verifyContentAssetReferences(contentWith('asset://dla-1'), CREDS),
    ).resolves.toBeUndefined()
  })

  it('提交前校验失败 → 清晰中文报错(提示站点切换场景)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [ASSET], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
    )
    await expect(
      verifyContentAssetReferences(contentWith('asset://dla-mrwfjyet-1wyimm'), CREDS),
    ).rejects.toThrow(/素材在当前站点.*不存在.*dla-mrwfjyet-1wyimm/s)
  })

  it('跨页扫描:第 2 页命中则通过', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [ASSET], total: 51, page: 1, pageSize: 50, totalPages: 2 }),
    )
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ ...ASSET, id: 'dla-2', assetId: 'v0c002', assetUrl: 'asset://v0c002' }],
        total: 51,
        page: 2,
        pageSize: 50,
        totalPages: 2,
      }),
    )
    await expect(
      verifyContentAssetReferences(contentWith('asset://v0c002'), CREDS),
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('list 调用失败时放行(fail-open,校验是防线不是闸门)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
    await expect(
      verifyContentAssetReferences(contentWith('asset://v0c001'), CREDS),
    ).resolves.toBeUndefined()
  })

  it('content 无 asset:// 引用时不发请求', async () => {
    await expect(
      verifyContentAssetReferences(contentWith('https://cdn.example/a.png'), CREDS),
    ).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('凭证缺失时直接放行(无法校验)', async () => {
    await expect(
      verifyContentAssetReferences(contentWith('asset://v0c001'), { apiKey: '', apiSecret: '' }),
    ).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('translateSeedanceTaskError', () => {
  it('把上游 LOCAL_ASSET_NOT_FOUND 400 翻译成中文人话', () => {
    const raw =
      'Seedance API 400: [LOCAL_ASSET_NOT_FOUND] content[1] referenced local asset is missing: asset://dla-mrwfjyet-1wyimm'
    const msg = translateSeedanceTaskError(raw)
    expect(msg).toMatch(/素材在当前站点.*不存在/s)
    expect(msg).toContain('asset://dla-mrwfjyet-1wyimm')
    expect(msg).toMatch(/切换了站点|切回原站点/)
  })

  it('其他错误原样返回', () => {
    expect(translateSeedanceTaskError('Seedance API 429: quota exceeded')).toBe(
      'Seedance API 429: quota exceeded',
    )
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
