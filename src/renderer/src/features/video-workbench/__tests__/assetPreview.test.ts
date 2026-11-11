// assetPreview 单测:asset:// previewUrl 会话级解析缓存 —— 同一 assetId
// 只查一次、并发合流一轮扫描、查不到只短暂记 miss;enrichAssetReferences
// 把 MCP CardInput 里的 asset:// 字符串升级成带 previewUrl 的 Material。
//
// 库只有一个:平台余额下的「素材库」(portraitLibrary.list / resolve,按计费池)。
// 自填 Miau Key 模式没有人像库(vvdance 直连已删除),那边一律「解析不到」且不发请求。

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

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/a'

const list = vi.fn()
const resolve = vi.fn()

const asset = (Id: string, extra: Record<string, unknown> = {}) => ({
  Id,
  Status: 'Active',
  AssetType: 'Image',
  URL: `${COS}/${Id}.png`,
  ...extra,
})

function mockList(items: Array<Record<string, unknown>>, truncated = false) {
  list.mockResolvedValue({
    ok: true,
    data: { Items: items, TotalCount: items.length, HiddenCount: 0, Truncated: truncated },
  })
}

/** 列表里没有的 id 按 id 单查也查不到。 */
function mockResolveNothing() {
  resolve.mockResolvedValue({ ok: true, data: null })
}

beforeEach(() => {
  resetAssetPreviewCacheForTest()
  list.mockReset()
  resolve.mockReset()
  mockResolveNothing()
  useQuotaStore.setState({ billingSource: 'platform', selectedPool: { projectId: 42, producerProjectId: null } })
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    portraitLibrary: { list, resolve },
  }
})

afterEach(() => {
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
  useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
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
  it('批量解析只发一次 list,出缩略图 + 原图地址;二次调用同 id 走缓存零请求', async () => {
    mockList([asset('a1', { Name: '猫头' }), asset('a2', { Name: '狗头' })])
    const found = await resolveAssetPreviews(['a1', 'a2', 'a1'])
    const a1 = found.get('a1')
    expect(a1?.name).toBe('猫头')
    expect(a1?.previewUrl).toContain('/a/a1.png?imageMogr2/thumbnail/')
    expect(a1?.sourceUrl).toBe(`${COS}/a1.png`)
    expect(found.get('a2')?.name).toBe('狗头')
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith({ projectId: 42, producerProjectId: null })

    const again = await resolveAssetPreviews(['a1'])
    expect(again.get('a1')?.previewUrl).toContain('/a/a1.png')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('并发调用合流成一轮扫描', async () => {
    mockList([asset('a1')])
    const [r1, r2] = await Promise.all([resolveAssetPreviews(['a1']), resolveAssetPreviews(['a1'])])
    expect(r1.get('a1')?.previewUrl).toContain('/a/a1.png')
    expect(r2.get('a1')?.previewUrl).toContain('/a/a1.png')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('库里没有的 id 记 null 不再重查(占位兜底)', async () => {
    mockList([])
    const found = await resolveAssetPreviews(['ghost'])
    expect(found.has('ghost')).toBe(false)
    expect(getCachedAssetPreview('ghost')).toBeNull()
    await resolveAssetPreviews(['ghost'])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('list 抛错不炸,返回空(下批新 id 可重试扫描)', async () => {
    list.mockRejectedValue(new Error('boom'))
    const found = await resolveAssetPreviews(['a1'])
    expect(found.size).toBe(0)
  })

  it('列表里没有的按 id 单查;两边都没有才记 miss', async () => {
    mockList([], true)
    resolve.mockImplementation(async (_scope: unknown, id: string) =>
      id === 'deep' ? { ok: true, data: asset('deep') } : { ok: true, data: null },
    )
    const found = await resolveAssetPreviews(['deep', 'ghost'])
    expect(found.get('deep')?.sourceUrl).toContain('/a/deep.png')
    expect(getCachedAssetPreview('ghost')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('缓存按计费池分区:换池后同一个 id 重新查', async () => {
    mockList([asset('p1')])
    await resolveAssetPreviews(['p1'])
    useQuotaStore.setState({ selectedPool: { projectId: 7, producerProjectId: 3 } })
    expect(getCachedAssetPreview('p1')).toBeUndefined()
    mockList([])
    mockResolveNothing()
    await resolveAssetPreviews(['p1'])
    expect(list).toHaveBeenLastCalledWith({ projectId: 7, producerProjectId: 3 })
    expect(getCachedAssetPreview('p1')).toBeNull()
  })
})

describe('withCachedAssetPreview', () => {
  it('缓存命中补 previewUrl;已有 previewUrl / 非 asset:// 原样返回', async () => {
    mockList([asset('a1')])
    await resolveAssetPreviews(['a1'])
    const filled = withCachedAssetPreview({ name: 'x', src: 'asset://a1' })
    expect(filled.name).toBe('x')
    expect(filled.src).toBe('asset://a1')
    expect(filled.previewUrl).toContain('/a/a1.png?imageMogr2/thumbnail/')
    const withPreview = { name: 'x', src: 'asset://a1', previewUrl: 'https://keep.jpg' }
    expect(withCachedAssetPreview(withPreview)).toBe(withPreview)
    const local = { name: 'y', src: 'D:\\y.png' }
    expect(withCachedAssetPreview(local)).toBe(local)
  })
})

describe('enrichAssetReferences(MCP 写入侧)', () => {
  it('asset:// 字符串升级成带 previewUrl/name 的 Material;跨任务只查一次', async () => {
    mockList([asset('a1', { Name: '主角立绘' }), asset('a2', { Name: '场景' })])
    const out = await enrichAssetReferences([
      { prompt: '第一镜', referenceImages: ['asset://a1', 'D:\\local.png'] },
      { prompt: '第二镜', referenceImages: ['asset://a2'], referenceAudios: ['asset://a1'] },
    ])
    expect(list).toHaveBeenCalledTimes(1)
    expect(out[0].referenceImages).toEqual([
      { name: '主角立绘', src: 'asset://a1', previewUrl: expect.stringContaining('/a/a1.png') },
      'D:\\local.png',
    ])
    expect(out[1].referenceImages).toEqual([
      { name: '场景', src: 'asset://a2', previewUrl: expect.stringContaining('/a/a2.png') },
    ])
    expect(out[1].referenceAudios).toEqual([
      { name: '主角立绘', src: 'asset://a1', previewUrl: expect.stringContaining('/a/a1.png') },
    ])
  })

  it('查不到 / list 失败保持字符串原样(提交链路不受影响)', async () => {
    list.mockRejectedValue(new Error('boom'))
    const out = await enrichAssetReferences([{ referenceImages: ['asset://ghost'] }])
    expect(out[0].referenceImages).toEqual(['asset://ghost'])
  })

  it('没有 asset:// 引用时零请求、原对象直返', async () => {
    const input = [{ prompt: '纯文生', referenceImages: ['https://x/y.png'] }]
    const out = await enrichAssetReferences(input)
    expect(out[0]).toBe(input[0])
    expect(list).not.toHaveBeenCalled()
  })

  it('视频素材不把媒体地址当缩略图(塞进 <img> 只会裂),只给原始地址 + 名字', async () => {
    mockList([asset('v1', { AssetType: 'Video', Name: '动作参考', URL: 'https://cdn/v1.mp4' })])
    const [out] = await enrichAssetReferences([{ referenceVideos: ['asset://v1'] }])
    expect(out.referenceVideos).toEqual([{ name: '动作参考', src: 'asset://v1' }])
    expect(getCachedAssetPreview('v1')).toEqual({ name: '动作参考', sourceUrl: 'https://cdn/v1.mp4' })
  })
})

describe('查不到只短暂记住', () => {
  it('miss 在 MISS_TTL_MS 内不重查,过期后重新查(agent 刚登记的素材列表里暂时没有)', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    mockList([])
    await resolveAssetPreviews(['fresh'])
    expect(getCachedAssetPreview('fresh')).toBeNull()

    now.mockReturnValue(1_000_000 + MISS_TTL_MS + 1)
    expect(getCachedAssetPreview('fresh')).toBeUndefined()
    mockList([asset('fresh')])
    const found = await resolveAssetPreviews(['fresh'])
    expect(found.get('fresh')?.previewUrl).toContain('/a/fresh.png')
    expect(list).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })
})

// 自填 Miau Key 没有人像库:asset:// 一律「解析不到」,而且不能发任何请求。
// getCachedAssetPreview 必须回 null(查过没有)而不是 undefined —— 后者会让缩略图 / 预览弹窗
// 一直转圈、并在每次渲染时重新触发解析。
describe('自填 Miau Key:没有人像库,asset:// 按解析不到处理', () => {
  beforeEach(() => {
    useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
  })

  it('resolveAssetPreviews 返回空、零请求', async () => {
    const found = await resolveAssetPreviews(['a1', 'a2'])
    expect(found.size).toBe(0)
    expect(list).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('getCachedAssetPreview 回 null(不是 undefined),withCachedAssetPreview 原样返回', () => {
    expect(getCachedAssetPreview('a1')).toBeNull()
    const m = { name: 'x', src: 'asset://a1' }
    expect(withCachedAssetPreview(m)).toBe(m)
  })

  it('enrichAssetReferences 保持字符串原样,零请求', async () => {
    const out = await enrichAssetReferences([{ referenceImages: ['asset://a1'] }])
    expect(out[0].referenceImages).toEqual(['asset://a1'])
    expect(list).not.toHaveBeenCalled()
  })

  it('平台余额但还没选计费池:同样没有库,零请求', async () => {
    useQuotaStore.setState({ billingSource: 'platform', selectedPool: null })
    const found = await resolveAssetPreviews(['a1'])
    expect(found.size).toBe(0)
    expect(getCachedAssetPreview('a1')).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('自填 Key 期间不写 miss:切到平台余额后能正常解析', async () => {
    await resolveAssetPreviews(['a1'])
    useQuotaStore.setState({ billingSource: 'platform', selectedPool: { projectId: 42, producerProjectId: null } })
    expect(getCachedAssetPreview('a1')).toBeUndefined()
    mockList([asset('a1')])
    const found = await resolveAssetPreviews(['a1'])
    expect(found.get('a1')?.previewUrl).toContain('/a/a1.png')
  })
})
