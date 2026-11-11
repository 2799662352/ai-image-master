// MaterialThumb / useMaterialThumbSrcs 单测:本地路径素材必须经
// useResolvedMediaSrc(IPC → blob:)解析后再进 <img src> —— 直接塞
// local-file:// / 裸盘符路径在 Electron 渲染端会裂图(缩略图显示失败 bug
// 的根因);解析失败时兜底渲染占位内容而非裂图。

import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'
import { resetAssetPreviewCacheForTest } from '../../../features/video-workbench/assetPreview'
import { useQuotaStore } from '../../../stores/useQuotaStore'
import { MaterialThumb, materialThumbTarget, useMaterialThumbSrcs } from '../MaterialThumb'

const readMediaThumb = vi.fn()
const readThumb = vi.fn()
// 平台人像库(素材库)桥:asset:// 的预览只能从它查回来(自填 Miau Key 没有库)。
const portraitList = vi.fn()
const portraitResolve = vi.fn()

const emptyLibrary = { ok: true, data: { Items: [], TotalCount: 0, HiddenCount: 0, Truncated: false } }

beforeEach(() => {
  readMediaThumb.mockReset()
  readThumb.mockReset()
  portraitList.mockReset()
  portraitList.mockResolvedValue(emptyLibrary)
  portraitResolve.mockReset()
  portraitResolve.mockResolvedValue({ ok: true, data: null })
  resetAssetPreviewCacheForTest()
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { readMediaThumb, readThumb },
    portraitLibrary: { list: portraitList, resolve: portraitResolve },
  }
  let n = 0
  ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
    `blob:stub-${++n}`
  ;(globalThis.URL as unknown as { revokeObjectURL: (s: string) => void }).revokeObjectURL = () => {}
})

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
  useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
})

const okThumb = () => ({
  ok: true,
  base64: Buffer.from('jpeg-bytes').toString('base64'),
  mime: 'image/jpeg',
})

describe('materialThumbTarget', () => {
  it('previewUrl 对任何 kind 都优先', () => {
    const m: VideoWorkbenchMaterial = { name: 'a', src: 'asset://x', previewUrl: 'https://cdn/p.jpg' }
    expect(materialThumbTarget('video', m)).toBe('https://cdn/p.jpg')
  })

  it('图片素材无 previewUrl 用 src;asset:// 源不出图', () => {
    expect(materialThumbTarget('image', { name: 'a', src: 'D:\\pics\\cat.png' })).toBe('D:\\pics\\cat.png')
    expect(materialThumbTarget('image', { name: 'a', src: 'asset://abc' })).toBeUndefined()
  })

  it('视频/音频素材无 previewUrl 不出图(emoji 占位)', () => {
    expect(materialThumbTarget('video', { name: 'a', src: 'D:\\v.mp4' })).toBeUndefined()
    expect(materialThumbTarget('audio', { name: 'a', src: 'D:\\a.mp3' })).toBeUndefined()
  })
})

describe('MaterialThumb', () => {
  it('本地 Windows 路径经 IPC 解析成 blob: 后渲染(绝不直接塞裸路径/local-file://)', async () => {
    readMediaThumb.mockResolvedValue(okThumb())
    render(
      <MaterialThumb
        kind="image"
        material={{ name: '猫.png', src: 'D:\\pics\\猫.png' }}
        fallback={<span>fallback</span>}
      />,
    )
    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toMatch(/^blob:/)
    expect(readMediaThumb).toHaveBeenCalledWith(expect.objectContaining({ path: 'D:\\pics\\猫.png' }))
  })

  it('data: URL 直通渲染,不走 IPC', async () => {
    render(
      <MaterialThumb
        kind="image"
        material={{ name: 'x', src: 'data:image/png;base64,AAA' }}
        fallback={<span>fallback</span>}
      />,
    )
    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAA')
    expect(readMediaThumb).not.toHaveBeenCalled()
  })

  it('previewUrl(https)直通;视频素材也能出图', async () => {
    render(
      <MaterialThumb
        kind="video"
        material={{ name: 'v', src: 'asset://x', previewUrl: 'https://cdn/p.jpg' }}
        fallback={<span>fallback</span>}
      />,
    )
    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('https://cdn/p.jpg')
  })

  it('IPC 读取失败 → 渲染 fallback 而非裂图', async () => {
    readMediaThumb.mockResolvedValue({ ok: false, reason: 'file not found' })
    readThumb.mockResolvedValue({ ok: false, reason: 'file not found' })
    render(
      <MaterialThumb
        kind="image"
        material={{ name: '丢失.png', src: 'D:\\gone.png' }}
        fallback={<span>丢失.png</span>}
      />,
    )
    await waitFor(() => expect(screen.getByText('丢失.png')).toBeTruthy())
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('<img> 加载失败(onError)→ 切换到 fallback', async () => {
    render(
      <MaterialThumb
        kind="image"
        material={{ name: '坏图.png', src: 'data:image/png;base64,broken' }}
        fallback={<span>坏图.png</span>}
      />,
    )
    const img = await screen.findByRole('img')
    fireEvent.error(img)
    await waitFor(() => expect(screen.getByText('坏图.png')).toBeTruthy())
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('useMaterialThumbSrcs(chip / @ 建议数据源)', () => {
  it('本地路径解析为 blob:,直通源保持原样,本地视频走截帧缩略图', async () => {
    readMediaThumb.mockResolvedValue(okThumb())
    const entries = [
      { kind: 'image' as const, material: { name: 'a', src: 'D:\\pics\\a.png' } },
      { kind: 'image' as const, material: { name: 'b', src: 'data:image/png;base64,BBB' } },
      { kind: 'video' as const, material: { name: 'v', src: 'D:\\v.mp4' } },
    ]
    const { result } = renderHook(() => useMaterialThumbSrcs(entries))
    await waitFor(() => expect(result.current[0]).toMatch(/^blob:/))
    expect(result.current[1]).toBe('data:image/png;base64,BBB')
    await waitFor(() => expect(result.current[2]).toMatch(/^blob:/))
    expect(readMediaThumb).toHaveBeenCalledWith(expect.objectContaining({ path: 'D:\\v.mp4' }))
  })

  it('视频截帧失败时不退回读整个文件(保持 undefined,消费方回落 🎬)', async () => {
    readMediaThumb.mockResolvedValue({ ok: false, reason: 'video frame extraction failed' })
    const entries = [{ kind: 'video' as const, material: { name: 'v', src: 'D:\\big.mp4' } }]
    const { result } = renderHook(() => useMaterialThumbSrcs(entries))
    await waitFor(() => expect(readMediaThumb).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(readThumb).not.toHaveBeenCalled()
    expect(result.current[0]).toBeUndefined()
  })

  it('解析失败的项保持 undefined(消费方回落 emoji)', async () => {
    readMediaThumb.mockResolvedValue({ ok: false, reason: 'file not found' })
    readThumb.mockResolvedValue({ ok: false, reason: 'file not found' })
    const entries = [{ kind: 'image' as const, material: { name: 'x', src: 'D:\\gone.png' } }]
    const { result } = renderHook(() => useMaterialThumbSrcs(entries))
    await waitFor(() => expect(readMediaThumb).toHaveBeenCalled())
    expect(result.current[0]).toBeUndefined()
  })
})

describe('asset:// 缺 previewUrl 的惰性解析(agent 挂上的旧数据兜底)', () => {
  beforeEach(() => {
    useQuotaStore.setState({ billingSource: 'platform', selectedPool: { projectId: 42, producerProjectId: null } })
  })

  // 非 COS 域名的地址不会被拼 imageMogr2,缩略图地址就是原地址,断言可以直接比整串。
  const mockLibrary = () =>
    portraitList.mockResolvedValue({
      ok: true,
      data: {
        Items: [
          { Id: 'a1', Name: '主角', Status: 'Active', AssetType: 'Image', URL: 'https://cdn/a1.jpg' },
          { Id: 'a2', Name: '场景', Status: 'Active', AssetType: 'Image', URL: 'https://cdn/a2.jpg' },
        ],
        TotalCount: 2,
        HiddenCount: 0,
        Truncated: false,
      },
    })

  it('MaterialThumb:惰性查素材库补 previewUrl 出图;同 assetId 多实例只查一次', async () => {
    mockLibrary()
    render(
      <>
        <MaterialThumb kind="image" material={{ name: 'x', src: 'asset://a1' }} fallback={<span>ph1</span>} />
        <MaterialThumb kind="image" material={{ name: 'y', src: 'asset://a1' }} fallback={<span>ph2</span>} />
      </>,
    )
    const imgs = await screen.findAllByRole('img')
    expect(imgs).toHaveLength(2)
    expect(imgs[0].getAttribute('src')).toBe('https://cdn/a1.jpg')
    expect(portraitList).toHaveBeenCalledTimes(1)
  })

  it('MaterialThumb:库里查不到 → 保持 fallback 占位,不再重查', async () => {
    render(
      <MaterialThumb kind="image" material={{ name: '孤儿.png', src: 'asset://ghost' }} fallback={<span>孤儿.png</span>} />,
    )
    await waitFor(() => expect(portraitList).toHaveBeenCalledTimes(1))
    expect(screen.getByText('孤儿.png')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    cleanup()
    render(
      <MaterialThumb kind="image" material={{ name: '孤儿.png', src: 'asset://ghost' }} fallback={<span>孤儿.png</span>} />,
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(portraitList).toHaveBeenCalledTimes(1)
  })

  it('useMaterialThumbSrcs:批量收集 assetId 共享一轮拉取(不按素材各发一次)', async () => {
    mockLibrary()
    const entries = [
      { kind: 'image' as const, material: { name: 'a', src: 'asset://a1' } },
      { kind: 'image' as const, material: { name: 'c', src: 'asset://a2' } },
      { kind: 'image' as const, material: { name: 'b', src: 'data:image/png;base64,BBB' } },
    ]
    const { result } = renderHook(() => useMaterialThumbSrcs(entries))
    await waitFor(() => expect(result.current[0]).toBe('https://cdn/a1.jpg'))
    expect(result.current[1]).toBe('https://cdn/a2.jpg')
    expect(result.current[2]).toBe('data:image/png;base64,BBB')
    expect(portraitList).toHaveBeenCalledTimes(1)
  })

  // 自填 Miau Key 没有人像库:asset:// 缩略图按「解析不到」处理 —— 直接显示占位,不转圈、不发请求。
  it('自填 Miau Key:asset:// 直接回落占位,不查任何库', async () => {
    useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
    render(
      <MaterialThumb kind="image" material={{ name: '孤儿.png', src: 'asset://a1' }} fallback={<span>孤儿.png</span>} />,
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.getByText('孤儿.png')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(portraitList).not.toHaveBeenCalled()
    expect(portraitResolve).not.toHaveBeenCalled()
  })
})
