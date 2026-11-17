/**
 * 缩略图位置不许加载原图 —— 组件层的行为契约。
 *
 * 用户原话:「带签名的链接和非 COS 链接没法拼缩略参数,缩略图位置会直接加载原图。加载原图是不行的」。
 * 真窗口量测:240 张 2336px 原图当缩略图,快速滚动丢掉 1.9–2.7 s、最长一帧 200 ms;
 * 同样 240 张换成小图,实际滚动速度下几乎不丢帧。
 *
 * 这里断言的是**每一个时刻** `<img>` 的 src 都不是 https / data: 原图:
 * 用 MutationObserver 记下整个过程中出现过的所有 `<img src>`,而不是只看最后一帧。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaThumbnail } from '../MediaThumbnail'
import { resetMediaSrcCacheForTest } from '../useResolvedMediaSrc'

const BUCKET = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com'
const HISTORY = `${BUCKET}/image-history/2026/11/17/abc.png`
const SIGNED = `${BUCKET}/x.png?q-sign-algorithm=sha1&q-ak=AKID&q-sign-time=1900000000;1900003600&q-signature=abc`
const R2 = 'https://pub-abc.r2.dev/gen/1.png'
const DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='

type Args = { path?: string; url?: string }
type Reply = { ok: true; base64: string; mime: string } | { ok: false; reason: string }
let readMediaThumb: ReturnType<typeof vi.fn>
let everSeenImgSrcs: Set<string>
let observer: MutationObserver | null = null

function install(handler: (args: Args) => Reply) {
  readMediaThumb = vi.fn(async (args: Args) => handler(args))
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { readMediaThumb, readThumb: vi.fn(async () => ({ ok: true, base64: 'FULL', mime: 'image/png' })) },
  }
}
const OK: Reply = { ok: true, base64: 'AAAA', mime: 'image/jpeg' }

/** 记下 container 里**出现过的**每一个 <img src>(包括只存在一瞬间的)。 */
function watchImgs(container: HTMLElement): void {
  const record = (): void => {
    container.querySelectorAll('img').forEach((i) => {
      const s = i.getAttribute('src')
      if (s) everSeenImgSrcs.add(s)
    })
  }
  observer = new MutationObserver(record)
  observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
  record()
}

const isRawOriginal = (s: string): boolean =>
  (/^https:/i.test(s) && !/imageMogr2\/thumbnail\/|\.thumb\d+\.webp$/.test(s)) || /^data:image\//i.test(s)

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  everSeenImgSrcs = new Set()
  resetMediaSrcCacheForTest()
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => `blob:mock/${Math.random()}`), configurable: true })
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  }
})

afterEach(() => {
  observer?.disconnect()
  observer = null
  cleanup()
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
})

describe('MediaThumbnail(image) — 原图不进 <img>', () => {
  it('别家 CDN 的原图:交给主进程缩小,<img> 只拿到 blob:', async () => {
    install(() => OK)
    const { container } = render(<MediaThumbnail src={R2} kind="image" name="a.png" />)
    watchImgs(container)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(readMediaThumb).toHaveBeenCalledWith({ url: R2, size: undefined })
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
    expect([...everSeenImgSrcs].filter(isRawOriginal)).toEqual([])
  })

  it('带签名的直出链接:不拼参数(会让签名失效),交给主进程,签名参数原样传过去', async () => {
    install(() => OK)
    const { container } = render(<MediaThumbnail src={SIGNED} kind="image" />)
    watchImgs(container)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(readMediaThumb).toHaveBeenCalledWith({ url: SIGNED, size: undefined })
    expect([...everSeenImgSrcs].filter(isRawOriginal)).toEqual([])
  })

  it('data: 内联图(实时出图那一刻):同样交给主进程', async () => {
    install(() => OK)
    const { container } = render(<MediaThumbnail src={DATA} kind="image" />)
    watchImgs(container)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(readMediaThumb).toHaveBeenCalledWith({ url: DATA, size: undefined })
    expect([...everSeenImgSrcs].filter(isRawOriginal)).toEqual([])
  })

  it('有本地副本:先用本地副本,一次下载都不发', async () => {
    install(() => OK)
    const { container } = render(
      <MediaThumbnail src={R2} fallbackSrcs={['local-file:///C:/out/a.png']} kind="image" />,
    )
    watchImgs(container)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(readMediaThumb.mock.calls[0][0]).toMatchObject({ path: 'C:/out/a.png' })
    expect(readMediaThumb.mock.calls.some((c) => (c[0] as Args).url)).toBe(false)
    expect([...everSeenImgSrcs].filter(isRawOriginal)).toEqual([])
  })

  it('本地副本读不到(被清理了):再交给主进程下载缩小,仍然不碰原图', async () => {
    install((args) => (args.path ? { ok: false, reason: 'file not found' } : OK))
    const { container } = render(
      <MediaThumbnail src={R2} fallbackSrcs={['local-file:///C:/out/gone.png']} kind="image" />,
    )
    watchImgs(container)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(readMediaThumb.mock.calls.map((c) => c[0])).toEqual([
      { path: 'C:/out/gone.png', size: undefined },
      { url: R2, size: undefined },
    ])
    expect([...everSeenImgSrcs].filter(isRawOriginal)).toEqual([])
  })

  it('自家 COS 裸链接:缩略形态先上(持久化缩略图 → 实时缩略),原图最后才交给主进程', async () => {
    install(() => OK)
    const { container } = render(<MediaThumbnail src={HISTORY} kind="image" />)
    watchImgs(container)
    // 第一条是持久化缩略图(普通 COS 对象),可以直接给 <img>。
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      `${BUCKET}/image-history/2026/11/17/abc.thumb512.webp`,
    )
    expect(readMediaThumb).not.toHaveBeenCalled()
    expect([...everSeenImgSrcs].filter(isRawOriginal)).toEqual([])
  })

  it('主进程也缩不出来:画占位卡,而不是退回原图', async () => {
    install(() => ({ ok: false, reason: 'url: HTTP 403' }))
    const { container } = render(<MediaThumbnail src={R2} kind="image" name="a.png" />)
    watchImgs(container)
    await flush()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('media-thumbnail-broken')).toBeTruthy()
    expect([...everSeenImgSrcs].filter(isRawOriginal)).toEqual([])
  })

  it('已经是缩略形态的远程地址(imageMogr2 缩略链接)直接给 <img>,不绕主进程', async () => {
    install(() => OK)
    const thumb = `${HISTORY}?imageMogr2/thumbnail/512x512%3E/format/webp/quality/85/ignore-error/1`
    const { container } = render(<MediaThumbnail src={thumb} kind="image" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(thumb)
    await flush()
    expect(readMediaThumb).not.toHaveBeenCalled()
  })

  it('SVG 是矢量文本:https .svg 直接给浏览器', () => {
    install(() => OK)
    const svg = `${BUCKET}/icon.svg`
    const { container } = render(<MediaThumbnail src={svg} kind="image" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(svg)
    expect(readMediaThumb).not.toHaveBeenCalled()
  })

  it('src 换成另一张图:新图重新走主进程,旧图的结果不会串过来', async () => {
    install((args) => ({ ok: true, base64: args.url?.endsWith('b.png') ? 'BBBB' : 'AAAA', mime: 'image/jpeg' }))
    const A = 'https://pub-abc.r2.dev/gen/a.png'
    const B = 'https://pub-abc.r2.dev/gen/b.png'
    const { container, rerender } = render(<MediaThumbnail src={A} kind="image" />)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    rerender(<MediaThumbnail src={B} kind="image" />)
    await waitFor(() => expect(readMediaThumb).toHaveBeenCalledTimes(2))
    expect(readMediaThumb.mock.calls[1][0]).toMatchObject({ url: B })
  })
})

describe('MediaThumbnail — 不该动的', () => {
  it('视频:候选就是视频本身,https 视频地址原样给 <video>', () => {
    install(() => OK)
    const mp4 = `${BUCKET}/clip.mp4`
    const { container } = render(<MediaThumbnail src={mp4} kind="video" />)
    expect(container.querySelector('video')?.getAttribute('src')).toBe(mp4)
    expect(readMediaThumb).not.toHaveBeenCalled()
  })

  it('没有主进程通道(纯网页预览 / 没有 Electron 的环境):保持原样,能显示的图不变成占位', () => {
    delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
    const { container } = render(<MediaThumbnail src={R2} kind="image" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(R2)
    expect(screen.queryByTestId('media-thumbnail-broken')).toBeNull()
  })

  it('本地路径照旧走 media:thumb(path),不带 url', async () => {
    install(() => OK)
    const { container } = render(<MediaThumbnail src="local-file:///C:/out/a.png" kind="image" />)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(readMediaThumb.mock.calls[0][0]).toEqual({ path: 'C:/out/a.png', size: undefined })
  })
})
