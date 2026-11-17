/**
 * 聊天里的图 / 视频缩略图只在「滚到附近」时才加载。
 *
 * 回归:对话里有几百张生成图时,每个缩略图挂载就立刻去读盘 / 发请求 / 生成视频封面:
 *  - 本地图 = 几百个 `media:thumb` 同时打到主进程(真窗口量测 240 张:主进程事件循环停 3.3 s、
 *    渲染进程一个 2.9 s 的长任务,期间滚轮和收起线程侧栏整个窗口冻住);
 *  - 远端大图 = 几百张同时解码(滚轮 80 格丢掉 2.7 s 的帧)。
 */
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMediaSrcCacheForTest } from '../../../components/shared/media/useResolvedMediaSrc'
import { NEAR_VIEWPORT_MARGIN_PX } from '../../../components/shared/media/useNearViewport'
import { MediaThumbWithPoster, useResolvedVideoPoster } from '../MediaThumbWithPoster'
import { __resetVideoPosterCacheForTests, setCachedPoster } from '../videoPosterCache'

const COS_VIDEO =
  'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/media-relay/2026/06/29/5caba59c7886f0ce.mp4'
const LOCAL_IMG = 'local-file:///C:/gen/a.png'
// 数据万象缩略链接 = 「本来就是小图」的远端形态,直接交给 <img>(原图不会,见下)。
const thumbForm = (name: string): string => `https://cdn.test/${name}?imageMogr2/thumbnail/512x512%3E/format/webp`
const REMOTE_THUMB_A = thumbForm('a.png')
const REMOTE_THUMB_B = thumbForm('b.png')
const REMOTE_THUMB_C = thumbForm('c.png')
const REMOTE_THUMB_D = thumbForm('d.png')

class FakeIO {
  static instances: FakeIO[] = []
  targets: Element[] = []
  disconnected = false
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly opts: IntersectionObserverInit | undefined,
  ) {
    FakeIO.instances.push(this)
  }
  observe(el: Element): void {
    this.targets.push(el)
  }
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  disconnect(): void {
    this.disconnected = true
  }
  fire(isIntersecting: boolean): void {
    act(() => {
      this.cb(
        [{ isIntersecting, target: this.targets[0] } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    })
  }
}

type AnyGlobal = typeof globalThis & { electronAPI?: unknown }

function installApis() {
  const readMediaThumb = vi.fn(async (_a: { path?: string; url?: string }) => ({
    ok: true as const,
    base64: 'AAAA',
    mime: 'image/jpeg',
  }))
  const ensureVideoPoster = vi.fn(async (_u: string) => ({
    ok: true as const,
    posterUrl: `${COS_VIDEO}.poster.jpg`,
    generated: false,
  }))
  ;(globalThis as AnyGlobal).electronAPI = {
    attachments: { readMediaThumb, readThumb: vi.fn(), ensureVideoPoster },
  }
  return { readMediaThumb, ensureVideoPoster }
}

beforeEach(() => {
  FakeIO.instances = []
  resetMediaSrcCacheForTest()
  __resetVideoPosterCacheForTests()
  vi.stubGlobal('IntersectionObserver', FakeIO)
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => `blob:mock/${Math.random()}`),
      configurable: true,
    })
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (globalThis as AnyGlobal).electronAPI
})

describe('MediaThumbWithPoster · 滚到附近才加载', () => {
  it('本地图:还没靠近 → 不读盘、不画图、不画「加载失败」;靠近后才读盘并出图', async () => {
    const { readMediaThumb } = installApis()
    const { container, queryByTestId } = render(
      <MediaThumbWithPoster src={LOCAL_IMG} videoUri={LOCAL_IMG} kind="image" name="a.png" />,
    )
    // 空底框在,但没有任何加载动作。
    expect(container.querySelector('[data-media-kind="image"]')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(queryByTestId('media-thumbnail-broken')).toBeNull()
    expect(readMediaThumb).not.toHaveBeenCalled()

    FakeIO.instances[0].fire(true)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(readMediaThumb.mock.calls[0][0].path).toBe('C:/gen/a.png')
    expect(queryByTestId('media-thumbnail-broken')).toBeNull()
  })

  // 远端用「缩略形态」的地址(数据万象缩略链接):它直接交给 <img>,门控行为能同步断言。
  // 远端「原图」不会直接交给 <img>(改由主进程缩小),见 MediaThumbnail.remote.test.tsx。
  it('远端图:还没靠近 → 不放 <img>(不发请求、不解码);靠近后才放', () => {
    installApis()
    const { container } = render(
      <MediaThumbWithPoster src={REMOTE_THUMB_A} videoUri="https://cdn.test/a.png" kind="image" />,
    )
    expect(container.querySelector('img')).toBeNull()
    FakeIO.instances[0].fire(true)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(REMOTE_THUMB_A)
  })

  it('远端原图:没靠近之前连主进程缩略请求都不发;靠近后才发,而且 <img> 拿到的是 blob 不是原图地址', async () => {
    const { readMediaThumb } = installApis()
    const { container } = render(
      <MediaThumbWithPoster src="https://cdn.test/full.png" videoUri="https://cdn.test/full.png" kind="image" />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(readMediaThumb).not.toHaveBeenCalled()

    FakeIO.instances[0].fire(true)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(readMediaThumb.mock.calls[0][0]).toMatchObject({ url: 'https://cdn.test/full.png' })
    expect(container.querySelector('img')?.getAttribute('src')).not.toBe('https://cdn.test/full.png')
  })

  it('视频:还没靠近 → 不放 <video>、不去生成封面;靠近后才放并生成', async () => {
    const { ensureVideoPoster } = installApis()
    const { container } = render(
      <MediaThumbWithPoster src={COS_VIDEO} videoUri={COS_VIDEO} kind="video" name="clip.mp4" />,
    )
    expect(container.querySelector('[data-media-kind="video"]')).toBeTruthy()
    expect(container.querySelector('video')).toBeNull()
    expect(ensureVideoPoster).not.toHaveBeenCalled()

    FakeIO.instances[0].fire(true)
    expect(container.querySelector('video')?.getAttribute('src')).toBe(COS_VIDEO)
    await waitFor(() => expect(ensureVideoPoster).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('poster')).toBe(`${COS_VIDEO}.poster.jpg`),
    )
  })

  it('视频封面已在缓存里:靠近的那一帧 <video> 就带着封面,不先裸挂一帧,也不再去生成', () => {
    const { ensureVideoPoster } = installApis()
    setCachedPoster(COS_VIDEO, `${COS_VIDEO}.poster.jpg`)
    const { container } = render(
      <MediaThumbWithPoster src={COS_VIDEO} videoUri={COS_VIDEO} kind="video" />,
    )
    expect(container.querySelector('video')).toBeNull()
    FakeIO.instances[0].fire(true)
    expect(container.querySelector('video')?.getAttribute('poster')).toBe(`${COS_VIDEO}.poster.jpg`)
    expect(ensureVideoPoster).not.toHaveBeenCalled()
  })

  it('useResolvedVideoPoster:缓存里有的封面在 videoUri 变成真地址的【第一次渲染】就给出,不等 effect', () => {
    setCachedPoster(COS_VIDEO, `${COS_VIDEO}.poster.jpg`)
    const seen: Array<string | undefined> = []
    const { rerender } = renderHook(
      ({ uri }: { uri: string }) => {
        const v = useResolvedVideoPoster(uri, undefined, 'video')
        seen.push(v)
        return v
      },
      { initialProps: { uri: '' } },
    )
    expect(seen.every((v) => v === undefined)).toBe(true)
    const before = seen.length
    rerender({ uri: COS_VIDEO })
    // 门控让 cosVideo 在「靠近」那一刻才变 true:缓存的封面要在这次渲染里就有,
    // 否则 <video> 会先无封面地挂一帧,等 effect 才补上。
    expect(seen[before]).toBe(`${COS_VIDEO}.poster.jpg`)
  })

  it('观察的是最近的滚动祖先,且往前多留一段;不相交的回调不触发加载', () => {
    installApis()
    const { container } = render(
      <div data-testid="scroller" style={{ overflowY: 'scroll' }}>
        <MediaThumbWithPoster src={REMOTE_THUMB_B} videoUri="https://cdn.test/b.png" kind="image" />
      </div>,
    )
    const io = FakeIO.instances[0]
    expect(io.opts?.root).toBe(container.querySelector('[data-testid="scroller"]'))
    expect(io.opts?.rootMargin).toBe(`${NEAR_VIEWPORT_MARGIN_PX}px 0px`)
    io.fire(false)
    expect(container.querySelector('img')).toBeNull()
  })

  it('靠近一次就不再回收:之后滚远了图还在,观察器已断开', () => {
    installApis()
    const { container } = render(
      <MediaThumbWithPoster src={REMOTE_THUMB_C} videoUri="https://cdn.test/c.png" kind="image" />,
    )
    const io = FakeIO.instances[0]
    io.fire(true)
    expect(container.querySelector('img')).toBeTruthy()
    expect(io.disconnected).toBe(true)
    io.fire(false)
    expect(container.querySelector('img')).toBeTruthy()
  })

  it('没有 IntersectionObserver(jsdom / 极老内核):和以前一样直接加载', () => {
    vi.unstubAllGlobals()
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    installApis()
    const { container } = render(
      <MediaThumbWithPoster src={REMOTE_THUMB_D} videoUri="https://cdn.test/d.png" kind="image" />,
    )
    expect(container.querySelector('img')).toBeTruthy()
  })
})
