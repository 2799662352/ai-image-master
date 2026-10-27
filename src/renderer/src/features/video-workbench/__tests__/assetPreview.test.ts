// assetPreview 单测:asset:// previewUrl 会话级解析缓存 —— 同一 assetId
// 只查一次、并发合流一轮扫描、查不到记 null 不重查;enrichAssetReferences
// 把 MCP CardInput 里的 asset:// 字符串升级成带 previewUrl 的 Material。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuotaStore } from '../../../stores/useQuotaStore'
import {
  enrichAssetReferences,
  extractAssetId,
  getCachedAssetPreview,
  MISS_TTL_MS,
  resetAssetPreviewCacheForTest,
  resolveAssetPreviews,
  withCachedAssetPreview,
} from '../assetPreview'

const listAssets = vi.fn()

function mockAssets(items: Array<{ assetId: string; name?: string; previewUrl?: string }>) {
  listAssets.mockResolvedValue({
    items: items.map((i) => ({ id: i.assetId, kind: 'image', assetUrl: `asset://${i.assetId}`, ...i })),
    total: items.length,
    page: 1,
    pageSize: 50,
    totalPages: 1,
  })
}

beforeEach(() => {
  resetAssetPreviewCacheForTest()
  listAssets.mockReset()
  useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    seedance: { listAssets },
  }
})

afterEach(() => {
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
})

describe('extractAssetId', () => {
  it('asset:// 前缀提取 id;其他形态返回 null', () => {
    expect(extractAssetId('asset://abc-123')).toBe('abc-123')
    expect(extractAssetId('asset://')).toBeNull()
    expect(extractAssetId('https://x/y.png')).toBeNull()
    expect(extractAssetId('D:\\a.png')).toBeNull()
  })
})

describe('resolveAssetPreviews(会话级缓存)', () => {
  it('批量解析只发一次 list;二次调用同 id 走缓存零请求', async () => {
    mockAssets([
      { assetId: 'a1', name: '猫头', previewUrl: 'https://cdn/a1.jpg' },
      { assetId: 'a2', name: '狗头', previewUrl: 'https://cdn/a2.jpg' },
    ])
    const found = await resolveAssetPreviews(['a1', 'a2', 'a1'])
    expect(found.get('a1')).toEqual({ previewUrl: 'https://cdn/a1.jpg', name: '猫头' })
    expect(found.get('a2')).toEqual({ previewUrl: 'https://cdn/a2.jpg', name: '狗头' })
    expect(listAssets).toHaveBeenCalledTimes(1)

    const again = await resolveAssetPreviews(['a1'])
    expect(again.get('a1')?.previewUrl).toBe('https://cdn/a1.jpg')
    expect(listAssets).toHaveBeenCalledTimes(1)
  })

  it('并发调用合流成一轮扫描', async () => {
    mockAssets([{ assetId: 'a1', previewUrl: 'https://cdn/a1.jpg' }])
    const [r1, r2] = await Promise.all([resolveAssetPreviews(['a1']), resolveAssetPreviews(['a1'])])
    expect(r1.get('a1')?.previewUrl).toBe('https://cdn/a1.jpg')
    expect(r2.get('a1')?.previewUrl).toBe('https://cdn/a1.jpg')
    expect(listAssets).toHaveBeenCalledTimes(1)
  })

  it('库里没有的 id 记 null 不再重查(占位兜底)', async () => {
    mockAssets([])
    const found = await resolveAssetPreviews(['ghost'])
    expect(found.has('ghost')).toBe(false)
    expect(getCachedAssetPreview('ghost')).toBeNull()
    await resolveAssetPreviews(['ghost'])
    expect(listAssets).toHaveBeenCalledTimes(1)
  })

  it('list 抛错不炸,返回空(下批新 id 可重试扫描)', async () => {
    listAssets.mockRejectedValue(new Error('no secret'))
    const found = await resolveAssetPreviews(['a1'])
    expect(found.size).toBe(0)
  })
})

describe('withCachedAssetPreview', () => {
  it('缓存命中补 previewUrl;已有 previewUrl / 非 asset:// 原样返回', async () => {
    mockAssets([{ assetId: 'a1', previewUrl: 'https://cdn/a1.jpg' }])
    await resolveAssetPreviews(['a1'])
    expect(withCachedAssetPreview({ name: 'x', src: 'asset://a1' })).toEqual({
      name: 'x',
      src: 'asset://a1',
      previewUrl: 'https://cdn/a1.jpg',
    })
    const withPreview = { name: 'x', src: 'asset://a1', previewUrl: 'https://keep.jpg' }
    expect(withCachedAssetPreview(withPreview)).toBe(withPreview)
    const local = { name: 'y', src: 'D:\\y.png' }
    expect(withCachedAssetPreview(local)).toBe(local)
  })
})

describe('enrichAssetReferences(MCP 写入侧)', () => {
  it('asset:// 字符串升级成带 previewUrl/name 的 Material;跨任务只查一次', async () => {
    mockAssets([
      { assetId: 'a1', name: '主角立绘', previewUrl: 'https://cdn/a1.jpg' },
      { assetId: 'a2', name: '场景', previewUrl: 'https://cdn/a2.jpg' },
    ])
    const out = await enrichAssetReferences([
      { prompt: '第一镜', referenceImages: ['asset://a1', 'D:\\local.png'] },
      { prompt: '第二镜', referenceImages: ['asset://a2'], referenceAudios: ['asset://a1'] },
    ])
    expect(listAssets).toHaveBeenCalledTimes(1)
    expect(out[0].referenceImages).toEqual([
      { name: '主角立绘', src: 'asset://a1', previewUrl: 'https://cdn/a1.jpg' },
      'D:\\local.png',
    ])
    expect(out[1].referenceImages).toEqual([
      { name: '场景', src: 'asset://a2', previewUrl: 'https://cdn/a2.jpg' },
    ])
    expect(out[1].referenceAudios).toEqual([
      { name: '主角立绘', src: 'asset://a1', previewUrl: 'https://cdn/a1.jpg' },
    ])
  })

  it('查不到 / list 失败保持字符串原样(提交链路不受影响)', async () => {
    listAssets.mockRejectedValue(new Error('boom'))
    const out = await enrichAssetReferences([{ referenceImages: ['asset://ghost'] }])
    expect(out[0].referenceImages).toEqual(['asset://ghost'])
  })

  it('没有 asset:// 引用时零请求、原对象直返', async () => {
    const input = [{ prompt: '纯文生', referenceImages: ['https://x/y.png'] }]
    const out = await enrichAssetReferences(input)
    expect(out[0]).toBe(input[0])
    expect(listAssets).not.toHaveBeenCalled()
  })
})

describe('查不到只短暂记住', () => {
  it('miss 在 MISS_TTL_MS 内不重查,过期后重新查(agent 刚登记的素材列表里暂时没有)', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    mockAssets([])
    await resolveAssetPreviews(['fresh'])
    expect(getCachedAssetPreview('fresh')).toBeNull()

    now.mockReturnValue(1_000_000 + MISS_TTL_MS + 1)
    expect(getCachedAssetPreview('fresh')).toBeUndefined()
    mockAssets([{ assetId: 'fresh', previewUrl: 'https://cdn/fresh.jpg' }])
    const found = await resolveAssetPreviews(['fresh'])
    expect(found.get('fresh')?.previewUrl).toBe('https://cdn/fresh.jpg')
    expect(listAssets).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })
})

// 平台余额下 agent 挂的是「素材库」(平台库)的 asset://。以前这里只扫 vvdance 库,
// 平台素材永远查不到 → 卡上没缩略图、预览弹窗报「素材库素材没有可预览地址」。
describe('平台余额:查素材库(按计费池)', () => {
  const list = vi.fn()
  const resolve = vi.fn()
  const asset = (Id: string, extra: Record<string, unknown> = {}) => ({
    Id,
    Status: 'Active',
    AssetType: 'Image',
    URL: `https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/a/${Id}.png`,
    ...extra,
  })

  beforeEach(() => {
    list.mockReset()
    resolve.mockReset()
    ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
      seedance: { listAssets },
      portraitLibrary: { list, resolve },
    }
    useQuotaStore.setState({ billingSource: 'platform', selectedPool: { projectId: 42, producerProjectId: null } })
  })

  afterEach(() => {
    useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
  })

  it('列表命中出缩略图 + 原图地址,不碰 vvdance 库', async () => {
    list.mockResolvedValue({ ok: true, data: { Items: [asset('p1', { Name: '女主' })], TotalCount: 1, HiddenCount: 0, Truncated: false } })
    const found = await resolveAssetPreviews(['p1'])
    const entry = found.get('p1')
    expect(entry?.name).toBe('女主')
    expect(entry?.previewUrl).toContain('/a/p1.png?imageMogr2/thumbnail/')
    expect(entry?.sourceUrl).toBe('https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/a/p1.png')
    expect(list).toHaveBeenCalledWith({ projectId: 42, producerProjectId: null })
    expect(listAssets).not.toHaveBeenCalled()
  })

  it('列表里没有的按 id 单查;两边都没有才记 miss', async () => {
    list.mockResolvedValue({ ok: true, data: { Items: [], TotalCount: 0, HiddenCount: 0, Truncated: true } })
    resolve.mockImplementation(async (_scope: unknown, id: string) =>
      id === 'deep' ? { ok: true, data: asset('deep') } : { ok: true, data: null },
    )
    const found = await resolveAssetPreviews(['deep', 'ghost'])
    expect(found.get('deep')?.sourceUrl).toContain('/a/deep.png')
    expect(getCachedAssetPreview('ghost')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('视频素材不把媒体地址当缩略图(塞进 <img> 只会裂),只给原始地址 + 名字', async () => {
    list.mockResolvedValue({
      ok: true,
      data: { Items: [asset('v1', { AssetType: 'Video', Name: '动作参考', URL: 'https://cdn/v1.mp4' })], TotalCount: 1, HiddenCount: 0, Truncated: false },
    })
    const [out] = await enrichAssetReferences([{ referenceVideos: ['asset://v1'] }])
    expect(out.referenceVideos).toEqual([{ name: '动作参考', src: 'asset://v1' }])
    expect(getCachedAssetPreview('v1')).toEqual({ name: '动作参考', sourceUrl: 'https://cdn/v1.mp4' })
  })

  it('缓存按计费池分区:换池后同一个 id 重新查', async () => {
    list.mockResolvedValue({ ok: true, data: { Items: [asset('p1')], TotalCount: 1, HiddenCount: 0, Truncated: false } })
    await resolveAssetPreviews(['p1'])
    useQuotaStore.setState({ selectedPool: { projectId: 7, producerProjectId: 3 } })
    expect(getCachedAssetPreview('p1')).toBeUndefined()
    list.mockResolvedValue({ ok: true, data: { Items: [], TotalCount: 0, HiddenCount: 0, Truncated: false } })
    resolve.mockResolvedValue({ ok: true, data: null })
    await resolveAssetPreviews(['p1'])
    expect(list).toHaveBeenLastCalledWith({ projectId: 7, producerProjectId: 3 })
    expect(getCachedAssetPreview('p1')).toBeNull()
  })
})
