// 「默认上传人像库」自动导入单测:importAsset 参数口径(dataUrl / kind /
// image_people 分类)、失败只 toast 不抛、preload 桥缺失静默跳过。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '../../../stores/useToastStore'
import { autoImportFilesToPortraitLibrary, fileImportKind } from '../portraitAutoImport'

const importAsset = vi.fn()

beforeEach(() => {
  importAsset.mockReset()
  useToastStore.setState({ toasts: [] })
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    seedance: { importAsset },
  }
})

function makeFile(name: string, type: string, content = 'x'): File {
  return new File([content], name, { type })
}

describe('fileImportKind', () => {
  it('按 MIME 分流图/视频/音频,其他类型 null', () => {
    expect(fileImportKind(makeFile('a.png', 'image/png'))).toBe('image')
    expect(fileImportKind(makeFile('a.mp4', 'video/mp4'))).toBe('video')
    expect(fileImportKind(makeFile('a.mp3', 'audio/mpeg'))).toBe('audio')
    expect(fileImportKind(makeFile('a.txt', 'text/plain'))).toBeNull()
  })
})

describe('autoImportFilesToPortraitLibrary', () => {
  it('图片以 dataUrl + image_people 分类导入;视频不带 imageCategory', async () => {
    importAsset.mockResolvedValue({ duplicated: false, asset: { assetId: 'a1' } })
    const n = await autoImportFilesToPortraitLibrary([
      makeFile('猫.png', 'image/png'),
      makeFile('走路.mp4', 'video/mp4'),
    ])
    expect(n).toBe(2)
    expect(importAsset).toHaveBeenCalledTimes(2)
    expect(importAsset).toHaveBeenNthCalledWith(1, {
      kind: 'image',
      imageCategory: 'image_people',
      url: expect.stringMatching(/^data:image\/png/),
      name: '猫.png',
      mimeType: 'image/png',
    })
    const videoCall = importAsset.mock.calls[1][0] as Record<string, unknown>
    expect(videoCall.kind).toBe('video')
    expect(videoCall).not.toHaveProperty('imageCategory')
    // 全部成功 → 不弹 toast
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('单文件导入失败只弹 error toast,不抛、不影响后续文件', async () => {
    importAsset
      .mockRejectedValueOnce(new Error('上游 500'))
      .mockResolvedValueOnce({ duplicated: false, asset: { assetId: 'a2' } })
    const n = await autoImportFilesToPortraitLibrary([
      makeFile('坏.png', 'image/png'),
      makeFile('好.png', 'image/png'),
    ])
    expect(n).toBe(1)
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].type).toBe('error')
    expect(toasts[0].message).toContain('坏.png')
    expect(toasts[0].message).toContain('上游 500')
  })

  it('preload 桥缺失时静默跳过(返回 0,不 toast 不抛)', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    const n = await autoImportFilesToPortraitLibrary([makeFile('猫.png', 'image/png')])
    expect(n).toBe(0)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('超出大小上限的文件弹 warning 跳过,不调 importAsset', async () => {
    const big = makeFile('大.png', 'image/png')
    Object.defineProperty(big, 'size', { value: 31 * 1024 * 1024 })
    const n = await autoImportFilesToPortraitLibrary([big])
    expect(n).toBe(0)
    expect(importAsset).not.toHaveBeenCalled()
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].type).toBe('warning')
  })
})
