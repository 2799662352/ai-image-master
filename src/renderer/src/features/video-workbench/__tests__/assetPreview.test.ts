// assetPreview 单测:asset:// previewUrl 会话级解析缓存 —— 同一 assetId
// 只查一次、并发合流一轮扫描、查不到记 null 不重查;enrichAssetReferences
// 把 MCP CardInput 里的 asset:// 字符串升级成带 previewUrl 的 Material。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enrichAssetReferences,
  extractAssetId,
  getCachedAssetPreview,
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
