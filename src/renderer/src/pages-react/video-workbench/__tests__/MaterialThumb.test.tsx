// MaterialThumb / useMaterialThumbSrcs 单测:本地路径素材必须经
// useResolvedMediaSrc(IPC → blob:)解析后再进 <img src> —— 直接塞
// local-file:// / 裸盘符路径在 Electron 渲染端会裂图(缩略图显示失败 bug
// 的根因);解析失败时兜底渲染占位内容而非裂图。

import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'
import { resetAssetPreviewCacheForTest } from '../../../features/video-workbench/assetPreview'
import { MaterialThumb, materialThumbTarget, useMaterialThumbSrcs } from '../MaterialThumb'

const readMediaThumb = vi.fn()
const readThumb = vi.fn()
const listAssets = vi.fn()

beforeEach(() => {
  readMediaThumb.mockReset()
  readThumb.mockReset()
  listAssets.mockReset()
  listAssets.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 })
  resetAssetPreviewCacheForTest()
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { readMediaThumb, readThumb },
    seedance: { listAssets },
  }
  let n = 0
  ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
    `blob:stub-${++n}`
  ;(globalThis.URL as unknown as { revokeObjectURL: (s: string) => void }).revokeObjectURL = () => {}
})

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
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
  it('本地路径解析为 blob:,直通源保持原样,视频无 previewUrl 为 undefined', async () => {
    readMediaThumb.mockResolvedValue(okThumb())
    const entries = [
      { kind: 'image' as const, material: { name: 'a', src: 'D:\\pics\\a.png' } },
      { kind: 'image' as const, material: { name: 'b', src: 'data:image/png;base64,BBB' } },
      { kind: 'video' as const, material: { name: 'v', src: 'D:\\v.mp4' } },
    ]
    const { result } = renderHook(() => useMaterialThumbSrcs(entries))
    await waitFor(() => expect(result.current[0]).toMatch(/^blob:/))
    expect(result.current[1]).toBe('data:image/png;base64,BBB')
    expect(result.current[2]).toBeUndefined()
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
  const mockLibrary = () =>
    listAssets.mockResolvedValue({
      items: [
        { id: 'a1', kind: 'image', name: '主角', assetId: 'a1', assetUrl: 'asset://a1', previewUrl: 'https://cdn/a1.jpg' },
        { id: 'a2', kind: 'video', name: '素材片段', assetId: 'a2', assetUrl: 'asset://a2', previewUrl: 'https://cdn/a2.jpg' },
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      totalPages: 1,
    })

  it('MaterialThumb:惰性查 listAssets 补 previewUrl 出图;同 assetId 多实例只查一次', async () => {
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
    expect(listAssets).toHaveBeenCalledTimes(1)
  })

  it('MaterialThumb:库里查不到 → 保持 fallback 占位,不再重查', async () => {
    render(
      <MaterialThumb kind="image" material={{ name: '孤儿.png', src: 'asset://ghost' }} fallback={<span>孤儿.png</span>} />,
    )
    await waitFor(() => expect(listAssets).toHaveBeenCalledTimes(1))
    expect(screen.getByText('孤儿.png')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    cleanup()
    render(
      <MaterialThumb kind="image" material={{ name: '孤儿.png', src: 'asset://ghost' }} fallback={<span>孤儿.png</span>} />,
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(listAssets).toHaveBeenCalledTimes(1)
  })

  it('useMaterialThumbSrcs:批量收集 assetId 共享一轮拉取(不按素材各发一次)', async () => {
    mockLibrary()
    const entries = [
      { kind: 'image' as const, material: { name: 'a', src: 'asset://a1' } },
      { kind: 'video' as const, material: { name: 'v', src: 'asset://a2' } },
      { kind: 'image' as const, material: { name: 'b', src: 'data:image/png;base64,BBB' } },
    ]
    const { result } = renderHook(() => useMaterialThumbSrcs(entries))
    await waitFor(() => expect(result.current[0]).toBe('https://cdn/a1.jpg'))
    expect(result.current[1]).toBe('https://cdn/a2.jpg')
    expect(result.current[2]).toBe('data:image/png;base64,BBB')
    expect(listAssets).toHaveBeenCalledTimes(1)
  })
})
