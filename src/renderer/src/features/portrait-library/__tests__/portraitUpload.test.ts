// 人像库共享上传模块单测:
//  - planUpload:按当前类型 tab 决定 imageCategory / 识别类型不匹配;
//  - uploadFilesToPortraitLibrary:importAsset 参数、归组 mutateOverlay 断言、失败 toast。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '../../../stores/useToastStore'
import { planUpload, uploadFilesToPortraitLibrary } from '../portraitUpload'

function makeFile(name: string, type: string): File {
  return new File(['x'], name, { type })
}

function mockApi(overrides: Record<string, unknown> = {}) {
  const importAsset = vi.fn(async (input: { name?: string }) => ({
    duplicated: false,
    asset: {
      id: 'row-n1',
      kind: 'image',
      name: input.name ?? 'n1',
      assetUrl: 'asset://n1',
      assetId: 'n1',
    },
  }))
  const mutateOverlay = vi.fn(async () => ({ entries: {}, groups: [] }))
  ;(window as any).electronAPI = { seedance: { importAsset, mutateOverlay, ...overrides } }
  return { importAsset, mutateOverlay }
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  delete (window as any).electronAPI
  vi.restoreAllMocks()
})

describe('planUpload — 按类型 tab 决定 imageCategory', () => {
  it('人像 tab 上传图片 → image_people,不算不匹配', () => {
    expect(planUpload(makeFile('a.png', 'image/png'), 'image_people')).toEqual({
      kind: 'image',
      imageCategory: 'image_people',
      mismatch: false,
    })
  })

  it('环境 tab 上传图片 → image_environment', () => {
    expect(planUpload(makeFile('a.png', 'image/png'), 'image_environment')).toEqual({
      kind: 'image',
      imageCategory: 'image_environment',
      mismatch: false,
    })
  })

  it('全部 tab 上传图片 → 默认 image_people', () => {
    expect(planUpload(makeFile('a.png', 'image/png'), 'all')).toEqual({
      kind: 'image',
      imageCategory: 'image_people',
      mismatch: false,
    })
  })

  it('音频 tab 上传图片 → 按图片入库(image_people)且 mismatch=true', () => {
    expect(planUpload(makeFile('a.png', 'image/png'), 'audio')).toEqual({
      kind: 'image',
      imageCategory: 'image_people',
      mismatch: true,
    })
  })

  it('环境 tab 上传音频 → 按音频入库(无 imageCategory)且 mismatch=true', () => {
    expect(planUpload(makeFile('a.mp3', 'audio/mpeg'), 'image_environment')).toEqual({
      kind: 'audio',
      mismatch: true,
    })
  })

  it('不支持的文件类型 → null', () => {
    expect(planUpload(makeFile('a.txt', 'text/plain'), 'all')).toBeNull()
  })
})

describe('uploadFilesToPortraitLibrary', () => {
  it('按 kindTab 传 imageCategory 调 importAsset,成功后返回素材', async () => {
    const { importAsset } = mockApi()
    const result = await uploadFilesToPortraitLibrary([makeFile('scene.png', 'image/png')], {
      kindTab: 'image_environment',
    })
    expect(importAsset).toHaveBeenCalledTimes(1)
    expect(importAsset.mock.calls[0][0]).toMatchObject({
      kind: 'image',
      imageCategory: 'image_environment',
      name: 'scene.png',
      mimeType: 'image/png',
    })
    expect(String((importAsset.mock.calls[0][0] as any).url)).toMatch(/^data:/)
    expect(result.imported).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.assets.map((a) => a.assetId)).toEqual(['n1'])
  })

  it('指定 group → 导入成功后 mutateOverlay(moveToGroup) 归组', async () => {
    const { mutateOverlay } = mockApi()
    await uploadFilesToPortraitLibrary([makeFile('p.png', 'image/png')], {
      kindTab: 'image_people',
      group: '引雷入局-道具锚-v1腾讯',
    })
    expect(mutateOverlay).toHaveBeenCalledWith({
      op: 'moveToGroup',
      assetIds: ['n1'],
      group: '引雷入局-道具锚-v1腾讯',
    })
  })

  it('未指定 group → 不调 mutateOverlay', async () => {
    const { mutateOverlay } = mockApi()
    await uploadFilesToPortraitLibrary([makeFile('p.png', 'image/png')], { kindTab: 'image_people' })
    expect(mutateOverlay).not.toHaveBeenCalled()
  })

  it('导入失败 → 计入 failed、toast 错误、onFileFailed 回调,且不归组', async () => {
    const { mutateOverlay } = mockApi({
      importAsset: vi.fn(async () => {
        throw new Error('网络错误')
      }),
    })
    const onFileFailed = vi.fn()
    const result = await uploadFilesToPortraitLibrary(
      [makeFile('p.png', 'image/png')],
      { kindTab: 'image_people', group: 'G1' },
      { onFileFailed },
    )
    expect(result.failed).toBe(1)
    expect(result.assets).toEqual([])
    expect(onFileFailed).toHaveBeenCalledWith(0)
    expect(mutateOverlay).not.toHaveBeenCalled()
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.type === 'error' && t.message.includes('上传失败'))).toBe(true)
  })

  it('类型与 tab 不匹配 → 按实际类型入库并 toast 说明', async () => {
    const { importAsset } = mockApi()
    await uploadFilesToPortraitLibrary([makeFile('p.png', 'image/png')], { kindTab: 'audio' })
    expect(importAsset.mock.calls[0][0]).toMatchObject({ kind: 'image', imageCategory: 'image_people' })
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.message.includes('分类不符'))).toBe(true)
  })

  it('图片超过 30MB → 跳过并 toast', async () => {
    const { importAsset } = mockApi()
    const big = makeFile('big.png', 'image/png')
    Object.defineProperty(big, 'size', { value: 31 * 1024 * 1024 })
    const result = await uploadFilesToPortraitLibrary([big], { kindTab: 'image_people' })
    expect(importAsset).not.toHaveBeenCalled()
    expect(result.failed).toBe(1)
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('30MB'))).toBe(true)
  })
})
