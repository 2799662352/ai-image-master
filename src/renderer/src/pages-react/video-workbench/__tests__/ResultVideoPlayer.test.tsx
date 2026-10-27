// ResultVideoPlayer 单测:生成结果的本地视频走**流式协议**
// (`local-file://media/?p=…`,见 file-explorer/uri.ts 的 toStreamableUri),
// 而不是把整份文件经 IPC 读成 base64 再转 blob:。
//
// 为什么换:这里是**每张 succeeded 卡片各一份**,一板十张成片就是十份视频常驻
// 渲染进程内存;而且 blob 没有 Range,进度条拖不动(seekable.end() 恒为 0)。
//
// 旧写法失败的真正原因到 2026-08-12 才查清:不是盘符,是**空 host** —— 标准 scheme
// 的空 host 会被 Blink 的 IsSafeToLoadURL 在渲染端直接拒掉,请求根本不发出去。
// 地址带上 host 之后这条路是通的。所以这里钉的是「必须是带 media 主机的流式地址」,
// 而不再是「必须是 blob:」。
//
// 播放失败(文件没了 / 编码不支持)由 <video> 的 error 事件报出来,自动降级远程源;
// 两边都没有时渲染错误兜底(路径 + 在文件夹中打开),不留空白播放器。

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

// 读字节那两个 IPC 仍然 mock 着,但只为了**断言它们没被调用** —— 本地播放改走
// 流式协议之后一个字节都不该经 IPC。留着比删掉有用:它们是这条纪律的探针。

function queryVideo(): HTMLVideoElement | null {
  return document.querySelector('video')
}

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

describe('ResultVideoPlayer — 本地播放(流式协议)', () => {
  it('localPath 直接喂带 media 主机的流式地址,不再读字节转 blob:', () => {
    const localPath = 'C:\\Users\\27996\\AppData\\Roaming\\catimation-cyberpunk-master\\agent\\uploads\\v.mp4'
    render(<ResultVideoPlayer source={makeCard({ localPath })} />)
    const src = queryVideo()?.getAttribute('src') ?? ''

    expect(src.startsWith('local-file://media/?p=')).toBe(true)
    // 路径整条在查询串里,盘符不参与路径规范化
    expect(decodeURIComponent(new URL(src).searchParams.get('p') ?? '')).toBe(localPath)
    // 一个字节都不该经 IPC —— 这正是「十张卡十份视频占内存」的来源
    expect(readThumb).not.toHaveBeenCalled()
    expect(readBinary).not.toHaveBeenCalled()
  })

  it('没有「读取中」这一档:流式源直接就位,不出 loading 占位', () => {
    render(<ResultVideoPlayer source={makeCard({ localPath: 'D:\\out\\v.mp4' })} />)
    expect(screen.queryByTestId('vw-playback-loading')).toBeNull()
    expect(queryVideo()).not.toBeNull()
  })

  it('本地播放失败(文件没了/编码不支持)且有 COS 永久 URL → 自动降级远程播放', async () => {
    render(
      <ResultVideoPlayer
        source={makeCard({ localPath: 'D:\\gone.mp4', remoteUrl: 'https://cos.example/v.mp4' })}
      />,
    )
    fireEvent.error(queryVideo()!)
    await waitFor(() => expect(queryVideo()?.getAttribute('src')).toBe('https://cos.example/v.mp4'))
  })

  it('本地播放失败 → 上报 onLocalUnavailable,兜底文案点明是本地副本读不出', async () => {
    vi.useFakeTimers()
    try {
      const onLocalUnavailable = vi.fn()
      render(
        <ResultVideoPlayer
          source={makeCard({ localPath: 'D:\\swept.mp4', videoUrl: 'https://tmp.example/v.mp4' })}
          onLocalUnavailable={onLocalUnavailable}
        />,
      )
      fireEvent.error(queryVideo()!)
      expect(onLocalUnavailable).toHaveBeenCalledTimes(1)
      expect(queryVideo()?.getAttribute('src')).toBe('https://tmp.example/v.mp4')
      // 远程也耗尽 → 兜底要先说本地那份没了,再说远程地址的事
      await burnRetryWindow()
      expect(screen.getByTestId('vw-playback-fallback').textContent).toContain('本地副本读不出')
    } finally {
      vi.useRealTimers()
    }
  })

  it('本地播放失败且只有上游临时地址 → 也降级', async () => {
    render(
      <ResultVideoPlayer
        source={makeCard({ localPath: 'D:\\broken.mp4', videoUrl: 'https://tmp.example/v.mp4' })}
      />,
    )
    fireEvent.error(queryVideo()!)
    await waitFor(() => expect(queryVideo()?.getAttribute('src')).toBe('https://tmp.example/v.mp4'))
  })
})

describe('ResultVideoPlayer — 失败兜底(不留空白播放器)', () => {
  it('本地播放失败且无远程源 → 显示路径 + 「在文件夹中打开」', async () => {
    render(<ResultVideoPlayer source={makeCard({ localPath: 'D:\\gone.mp4' })} />)
    fireEvent.error(queryVideo()!)
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
      // 这条地址没有预签名参数，有效期确实无从判断 —— 就如实说「未知」，
      // 而不是随口给一个「可能已过期」把人吓去重新生成。
      expect(fallback.textContent).toContain('链接有效期未知')
      expect(fallback.textContent).not.toContain('已过期')
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

/**
 * 「加载失败」不等于「片子没了」。放弃只说明内嵌播放器这条路没走通，而预签名地址
 * 通常还活着 —— 所以失败态必须留出口，否则用户面对一条还能看的视频，屏幕上唯一
 * 显眼的按钮是花钱重新生成。
 */
describe('ResultVideoPlayer · 失败之后还有路走', () => {
  const SIGNED = 'https://tos.example/v.mp4?X-Tos-Date=20260809T004221Z&X-Tos-Expires=86400'

  async function exhaust(url = 'https://cos.example/v.mp4'): Promise<void> {
    render(<ResultVideoPlayer source={makeCard({ remoteUrl: url })} />)
    await burnRetryWindow()
  }

  it('点「重试播放」回到播放器，从头再试一遍', async () => {
    vi.useFakeTimers()
    try {
      await exhaust()
      expect(screen.getByTestId('vw-playback-fallback')).toBeTruthy()

      fireEvent.click(screen.getByTestId('vw-playback-retry'))
      expect(screen.queryByTestId('vw-playback-fallback')).toBeNull()
      expect(queryVideo()).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('给出「在浏览器中打开」，用系统浏览器兜底', async () => {
    const openExternal = vi.fn()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { shell: { openExternal } }
    vi.useFakeTimers()
    try {
      await exhaust()
      fireEvent.click(screen.getByTestId('vw-playback-external'))
      expect(openExternal).toHaveBeenCalledWith('https://cos.example/v.mp4')
    } finally {
      vi.useRealTimers()
    }
  })

  it('地址是预签名且未过期时，明说是网络不通，不提重新生成', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 7, 9, 0, 55, 0))
    try {
      await exhaust(SIGNED)
      const text = screen.getByTestId('vw-playback-fallback').textContent!
      expect(text).toContain('链接未过期')
      expect(text).toContain('网络不通')
      expect(text).not.toContain('重新生成')
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * 放弃状态原本是黏住的:点完「重新保存」多出一条 COS 永久地址，屏幕上却还停在
   * 那句失败 —— 明明已经有能播的源了。
   */
  it('候选地址变了自动重试，不再钉死在失败上', async () => {
    vi.useFakeTimers()
    try {
      const card = makeCard({ remoteUrl: 'https://cos.example/v.mp4' })
      const { rerender } = render(<ResultVideoPlayer source={card} />)
      await burnRetryWindow()
      expect(screen.getByTestId('vw-playback-fallback')).toBeTruthy()

      rerender(<ResultVideoPlayer source={{ ...card, remoteUrl: 'https://cos.example/new.mp4' }} />)
      expect(screen.queryByTestId('vw-playback-fallback')).toBeNull()
      expect(queryVideo()?.getAttribute('src')).toBe('https://cos.example/new.mp4')
    } finally {
      vi.useRealTimers()
    }
  })
})