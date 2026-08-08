// ResultVideoPlayer 单测:生成结果视频必须把本地字节经 IPC 读回转 blob:
// 再喂 <video>(toRenderableUri 的 local-file:// 直塞 <video src> 在
// Electron 渲染端加载不出字节 —— 播放器空白、时长 0:00 的根因);本地读取
// 失败自动降级远程源;两边都没有时渲染错误兜底(路径 + 在文件夹中打开),
// 不留空白播放器。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    render(<ResultVideoPlayer source={makeCard({ localPath })} />)
    await waitFor(() => expect(queryVideo()).not.toBeNull())
    const video = queryVideo()!
    expect(video.getAttribute('src')).toMatch(/^blob:/)
    expect(video.getAttribute('src')).not.toContain('local-file')
    expect(readThumb).toHaveBeenCalledWith(localPath)
  })

  it('读取中先渲染 loading 占位,不出空白 <video>', () => {
    readThumb.mockReturnValue(new Promise(() => {}))
    render(<ResultVideoPlayer source={makeCard({ localPath: 'D:\\out\\v.mp4' })} />)
    expect(screen.getByTestId('vw-playback-loading')).toBeTruthy()
    expect(queryVideo()).toBeNull()
  })

  it('本地读取失败且有 COS 永久 URL → 自动降级远程播放', async () => {
    readThumb.mockResolvedValue({ ok: false, reason: 'file not found' })
    readBinary.mockResolvedValue({ ok: false, reason: 'file not found' })
    render(
      <ResultVideoPlayer
        source={makeCard({ localPath: 'D:\\gone.mp4', remoteUrl: 'https://cos.example/v.mp4' })}
      />,
    )
    await waitFor(() => expect(queryVideo()?.getAttribute('src')).toBe('https://cos.example/v.mp4'))
  })

  it('blob: 解码失败(onError)且有远程源 → 降级远程播放', async () => {
    readThumb.mockResolvedValue(okBytes())
    render(
      <ResultVideoPlayer
        source={makeCard({ localPath: 'D:\\broken.mp4', videoUrl: 'https://tmp.example/v.mp4' })}
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
    render(<ResultVideoPlayer source={makeCard({ localPath: 'D:\\gone.mp4' })} />)
    const fallback = await screen.findByTestId('vw-playback-fallback')
    expect(fallback.textContent).toContain('视频加载失败')
    expect(fallback.textContent).toContain('D:\\gone.mp4')
    expect(queryVideo()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /在文件夹中打开/ }))
    expect(showItemInFolder).toHaveBeenCalledWith('D:\\gone.mp4')
  })

  /**
   * 实测的失败是 `net::ERR_CONNECTION_CLOSED` —— 连接被掐断，不是过期（过期回 403）。
   * 此前一次 onError 就永久判死并提示「可能已过期，可重新生成」，把用户引去花钱
   * 重跑一条已经生成好的片子。现在要先重试，用尽了才认输。
   */
  it('远程加载失败先重试，不是一次就判死', async () => {
    vi.useFakeTimers()
    try {
      render(<ResultVideoPlayer source={makeCard({ remoteUrl: 'https://cos.example/v.mp4' })} />)
      fireEvent.error(queryVideo()!)
      // 还在重试期内：播放器仍在，不出兜底。
      expect(screen.queryByTestId('vw-playback-fallback')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(queryVideo()?.getAttribute('src')).toBe('https://cos.example/v.mp4')
    } finally {
      vi.useRealTimers()
    }
  })

  it('一个候选试满后降级到下一个（COS → 上游临时地址）', async () => {
    vi.useFakeTimers()
    try {
      render(<ResultVideoPlayer source={makeCard({
        remoteUrl: 'https://cos.example/v.mp4',
        videoUrl: 'https://tmp.example/v.mp4',
      })} />)
      // 把 COS 那个候选的 3 次机会用光。
      for (let i = 0; i < 3; i++) {
        fireEvent.error(queryVideo()!)
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      }
      // 不该判死 —— 还有上游地址没试。
      expect(screen.queryByTestId('vw-playback-fallback')).toBeNull()
      expect(queryVideo()?.getAttribute('src')).toBe('https://tmp.example/v.mp4')
    } finally {
      vi.useRealTimers()
    }
  })

  it('所有候选都试满 → 兜底，且不再断言「已过期」', async () => {
    vi.useFakeTimers()
    try {
      render(<ResultVideoPlayer source={makeCard({ remoteUrl: 'https://cos.example/v.mp4' })} />)
      for (let i = 0; i < 3; i++) {
        fireEvent.error(queryVideo()!)
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      }
      // 用 getBy 而不是 findBy：findBy 靠真实定时器轮询，在假计时器下会一直挂着。
      const fallback = screen.getByTestId('vw-playback-fallback')
      expect(fallback.textContent).toContain('次加载失败')
      // 原因是「网络问题或链接已过期」，不再单口咬定过期把人引去重新生成。
      expect(fallback.textContent).toContain('网络问题')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ResultVideoPlayer — 远程直通与源判定', () => {
  it('无 localPath 时远程 https 直塞 <video>,不走 IPC', () => {
    render(<ResultVideoPlayer source={makeCard({ videoUrl: 'https://tmp.example/v.mp4' })} />)
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
