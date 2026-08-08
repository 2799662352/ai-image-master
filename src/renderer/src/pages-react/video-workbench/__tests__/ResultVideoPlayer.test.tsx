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

  /** 把某个错误码贴到 <video> 上再触发 error —— 真实浏览器就是这么传递原因的。 */
  function failWith(code: number): void {
    const el = queryVideo()!
    Object.defineProperty(el, 'error', { value: { code }, configurable: true })
    fireEvent.error(el)
  }

  /** 反复报网络错并推进时钟，直到**当前候选**的重试时限耗尽（换源或出兜底）。 */
  async function burnRetryWindow(): Promise<void> {
    const from = queryVideo()?.getAttribute('src')
    for (let i = 0; i < 40; i++) {
      failWith(2 /* MEDIA_ERR_NETWORK */)
      await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
      const el = queryVideo()
      // 播放器没了 = 出兜底；src 变了 = 已降级到下一个候选。两种都算这轮烧完。
      if (!el || el.getAttribute('src') !== from) return
    }
  }

  it('重试期内会提示「正在重试」，60 秒静默和卡死在屏幕上长得一样', async () => {
    vi.useFakeTimers()
    try {
      render(<ResultVideoPlayer source={makeCard({ remoteUrl: 'https://cos.example/v.mp4' })} />)
      failWith(2 /* MEDIA_ERR_NETWORK */)
      await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
      expect(screen.getByTestId('vw-remote-retrying').textContent).toContain('正在重试')
      expect(screen.queryByTestId('vw-playback-fallback')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('时限用尽后降级到下一个候选（COS → 上游临时地址）', async () => {
    vi.useFakeTimers()
    try {
      render(<ResultVideoPlayer source={makeCard({
        remoteUrl: 'https://cos.example/v.mp4',
        videoUrl: 'https://tmp.example/v.mp4',
      })} />)
      await burnRetryWindow()
      expect(screen.queryByTestId('vw-playback-fallback')).toBeNull()
      expect(queryVideo()?.getAttribute('src')).toBe('https://tmp.example/v.mp4')
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * 「只重试瞬时错误」是退避策略的前提：对 403/404 这类永久错误重试，只是把失败
   * 推迟一分钟，期间用户还以为有救。SRC_NOT_SUPPORTED 就是 403 常落的那一档。
   */
  it('永久性错误不耗时限，立刻换下一个候选', async () => {
    vi.useFakeTimers()
    try {
      render(<ResultVideoPlayer source={makeCard({
        remoteUrl: 'https://cos.example/v.mp4',
        videoUrl: 'https://tmp.example/v.mp4',
      })} />)
      failWith(4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */)
      // 没有推进任何时钟 —— 立刻就该换源，一秒都不该等。
      expect(queryVideo()?.getAttribute('src')).toBe('https://tmp.example/v.mp4')
      expect(screen.queryByTestId('vw-remote-retrying')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('所有候选都试尽 → 兜底，且不再单口咬定「已过期」', async () => {
    vi.useFakeTimers()
    try {
      render(<ResultVideoPlayer source={makeCard({ remoteUrl: 'https://cos.example/v.mp4' })} />)
      await burnRetryWindow()
      // 用 getBy 而不是 findBy：findBy 靠真实定时器轮询，在假计时器下会一直挂着。
      const fallback = screen.getByTestId('vw-playback-fallback')
      expect(fallback.textContent).toContain('60 秒')
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
