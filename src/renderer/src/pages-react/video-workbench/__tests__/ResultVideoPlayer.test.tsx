// ResultVideoPlayer 单测:生成结果视频必须把本地字节经 IPC 读回转 blob:
// 再喂 <video>(toRenderableUri 的 local-file:// 直塞 <video src> 在
// Electron 渲染端加载不出字节 —— 播放器空白、时长 0:00 的根因);本地读取
// 失败自动降级远程源;两边都没有时渲染错误兜底(路径 + 在文件夹中打开),
// 不留空白播放器。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchCard } from '../../../../../types/videoWorkbench'
import { ResultVideoPlayer, hasPlaybackSource, remoteVideoSrc } from '../ResultVideoPlayer'

const readThumb = vi.fn()
const readBinary = vi.fn()
const showItemInFolder = vi.fn()

beforeEach(() => {
  readThumb.mockReset()
  readBinary.mockReset()
  showItemInFolder.mockReset()
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { readThumb },
    fs: { readBinary },
    shell: { showItemInFolder },
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

function makeCard(patch: Partial<VideoWorkbenchCard>): VideoWorkbenchCard {
  return {
    id: 'c1',
    order: 0,
    status: 'succeeded',
    createdAt: 1,
    updatedAt: 1,
    prompt: 'p',
    model: '2.0',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    generateAudio: true,
    mode: 'multimodal_ref',
    webSearch: false,
    referenceImages: [],
    referenceVideos: [],
    referenceAudios: [],
    ...patch,
  }
}

const okBytes = () => ({
  ok: true,
  base64: Buffer.from('mp4-bytes').toString('base64'),
  mime: 'video/mp4',
})

function queryVideo(): HTMLVideoElement | null {
  return document.querySelector('video')
}

describe('ResultVideoPlayer — 本地播放(IPC → blob:)', () => {
  it('localPath 经 attachments:read-thumb 读字节转 blob: 喂 <video>,绝不直塞 local-file://', async () => {
    readThumb.mockResolvedValue(okBytes())
    const localPath = 'C:\\Users\\27996\\AppData\\Roaming\\catimation-cyberpunk-master\\agent\\uploads\\v.mp4'
    render(<ResultVideoPlayer card={makeCard({ localPath })} />)
    await waitFor(() => expect(queryVideo()).not.toBeNull())
    const video = queryVideo()!
    expect(video.getAttribute('src')).toMatch(/^blob:/)
    expect(video.getAttribute('src')).not.toContain('local-file')
    expect(readThumb).toHaveBeenCalledWith(localPath)
  })

  it('读取中先渲染 loading 占位,不出空白 <video>', () => {
    readThumb.mockReturnValue(new Promise(() => {}))
    render(<ResultVideoPlayer card={makeCard({ localPath: 'D:\\out\\v.mp4' })} />)
    expect(screen.getByTestId('vw-playback-loading')).toBeTruthy()
    expect(queryVideo()).toBeNull()
  })

  it('本地读取失败且有 COS 永久 URL → 自动降级远程播放', async () => {
    readThumb.mockResolvedValue({ ok: false, reason: 'file not found' })
    readBinary.mockResolvedValue({ ok: false, reason: 'file not found' })
    render(
      <ResultVideoPlayer
        card={makeCard({ localPath: 'D:\\gone.mp4', remoteUrl: 'https://cos.example/v.mp4' })}
      />,
    )
    await waitFor(() => expect(queryVideo()?.getAttribute('src')).toBe('https://cos.example/v.mp4'))
  })

  it('blob: 解码失败(onError)且有远程源 → 降级远程播放', async () => {
    readThumb.mockResolvedValue(okBytes())
    render(
      <ResultVideoPlayer
        card={makeCard({ localPath: 'D:\\broken.mp4', videoUrl: 'https://tmp.example/v.mp4' })}
      />,
    )
    await waitFor(() => expect(queryVideo()?.getAttribute('src')).toMatch(/^blob:/))
    fireEvent.error(queryVideo()!)
    await waitFor(() => expect(queryVideo()?.getAttribute('src')).toBe('https://tmp.example/v.mp4'))
  })
})

describe('ResultVideoPlayer — 失败兜底(不留空白播放器)', () => {
  it('本地读取失败且无远程源 → 显示路径 + 「在文件夹中打开」', async () => {
    readThumb.mockResolvedValue({ ok: false, reason: 'file not found' })
    readBinary.mockResolvedValue({ ok: false, reason: 'file not found' })
    render(<ResultVideoPlayer card={makeCard({ localPath: 'D:\\gone.mp4' })} />)
    const fallback = await screen.findByTestId('vw-playback-fallback')
    expect(fallback.textContent).toContain('视频加载失败')
    expect(fallback.textContent).toContain('D:\\gone.mp4')
    expect(queryVideo()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /在文件夹中打开/ }))
    expect(showItemInFolder).toHaveBeenCalledWith('D:\\gone.mp4')
  })

  it('仅远程源且加载失败 → 显示错误兜底而非空白', async () => {
    render(<ResultVideoPlayer card={makeCard({ remoteUrl: 'https://cos.example/v.mp4' })} />)
    expect(queryVideo()?.getAttribute('src')).toBe('https://cos.example/v.mp4')
    fireEvent.error(queryVideo()!)
    const fallback = await screen.findByTestId('vw-playback-fallback')
    expect(fallback.textContent).toContain('远程地址加载失败')
  })
})

describe('ResultVideoPlayer — 远程直通与源判定', () => {
  it('无 localPath 时远程 https 直塞 <video>,不走 IPC', () => {
    render(<ResultVideoPlayer card={makeCard({ videoUrl: 'https://tmp.example/v.mp4' })} />)
    expect(queryVideo()?.getAttribute('src')).toBe('https://tmp.example/v.mp4')
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('remoteVideoSrc:COS 永久 URL 优先于上游临时地址', () => {
    expect(
      remoteVideoSrc({ remoteUrl: 'https://cos/v.mp4', videoUrl: 'https://tmp/v.mp4' }),
    ).toBe('https://cos/v.mp4')
    expect(remoteVideoSrc({ videoUrl: 'https://tmp/v.mp4' })).toBe('https://tmp/v.mp4')
    expect(remoteVideoSrc({})).toBeNull()
  })

  it('hasPlaybackSource:三源全缺 → false(外层不渲染结果区)', () => {
    expect(hasPlaybackSource({})).toBe(false)
    expect(hasPlaybackSource({ localPath: 'D:\\v.mp4' })).toBe(true)
    expect(hasPlaybackSource({ remoteUrl: 'https://x/v.mp4' })).toBe(true)
  })
})
