// `remote-thumb:` 源 —— 渲染端「远程 / 内联原图 → 主进程缩小 → blob:」这一段。
//
// 钉死的几件事:
//  - 走的是 `readMediaThumb({ url })`,绝不会碰「读原图」的 `readThumb`;
//  - 和本地源一样进共享 blob 缓存:同一地址并发 / 先后只问主进程一次,最后一个持有者放手才 revoke;
//  - 失败(null)不缓存 —— 网络恢复后下一次要能重来;
//  - 没有主进程通道时返回 null,而不是把原图地址透传出去。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteThumbSrc } from '../mediaFallback'
import {
  acquireMediaSrc,
  hasRemoteThumbBridge,
  needsMainResolve,
  releaseMediaSrc,
  resetMediaSrcCacheForTest,
  resolveMediaSrcOnce,
} from '../useResolvedMediaSrc'

const ORIGINAL = 'https://cdn.example.com/gen/full.png?sig=abc'
const SRC = toRemoteThumbSrc(ORIGINAL)

type Reply = { ok: true; base64: string; mime: string } | { ok: false; reason: string }
let readMediaThumb: ReturnType<typeof vi.fn>
let readThumb: ReturnType<typeof vi.fn>
let created: string[]
let revoked: string[]
let nextId: number

function install(reply: () => Reply | Promise<Reply>) {
  readMediaThumb = vi.fn(async () => reply())
  readThumb = vi.fn(async () => ({ ok: true as const, base64: 'FULL', mime: 'image/png' }))
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { attachments: { readMediaThumb, readThumb } }
}

beforeEach(() => {
  nextId = 0
  created = []
  revoked = []
  install(() => ({ ok: true, base64: 'AAA', mime: 'image/jpeg' }))
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:thumb-${++nextId}`
    created.push(url)
    return url
  }) as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url)
  }) as unknown as typeof URL.revokeObjectURL
})

afterEach(() => {
  resetMediaSrcCacheForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe('needsMainResolve', () => {
  it('本地路径与 remote-thumb: 要走主进程;https / blob / data / 空串不用', () => {
    expect(needsMainResolve(SRC)).toBe(true)
    expect(needsMainResolve('local-file:///C:/a.png')).toBe(true)
    expect(needsMainResolve('file:///C:/a.png')).toBe(true)
    expect(needsMainResolve('C:\\a.png')).toBe(true)
    expect(needsMainResolve('https://x.test/a.png')).toBe(false)
    expect(needsMainResolve('blob:http://localhost/x')).toBe(false)
    expect(needsMainResolve('data:image/png;base64,AAA')).toBe(false)
    expect(needsMainResolve('')).toBe(false)
    expect(needsMainResolve(undefined as unknown as string)).toBe(false)
  })
})

describe('hasRemoteThumbBridge', () => {
  it('有 readMediaThumb 才算有通道', () => {
    expect(hasRemoteThumbBridge()).toBe(true)
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { attachments: { readThumb: vi.fn() } }
    expect(hasRemoteThumbBridge()).toBe(false)
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    expect(hasRemoteThumbBridge()).toBe(false)
  })
})

describe('acquireMediaSrc(remote-thumb:…)', () => {
  it('把原图地址(含签名参数,一个字符不少)交给主进程缩略,拿回 blob:', async () => {
    const url = await acquireMediaSrc(SRC, 'image')
    expect(url).toBe('blob:thumb-1')
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(readMediaThumb).toHaveBeenCalledWith({ url: ORIGINAL, size: undefined })
  })

  it('绝不会走「读原图」的 readThumb,也不会把原图地址透传出去', async () => {
    const url = await acquireMediaSrc(SRC, 'image')
    expect(readThumb).not.toHaveBeenCalled()
    expect(url).not.toBe(ORIGINAL)
    expect(url).not.toBe(SRC)
  })

  it('thumbSize 透传给主进程', async () => {
    await acquireMediaSrc(SRC, 'image', { thumbSize: 512 })
    expect(readMediaThumb).toHaveBeenCalledWith({ url: ORIGINAL, size: 512 })
  })

  it('主进程回的 mime 用来造 blob(透明图是 webp,不是 jpeg)', async () => {
    install(() => ({ ok: true, base64: 'AAA', mime: 'image/webp' }))
    const blobs: Blob[] = []
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b)
      return 'blob:x'
    }) as unknown as typeof URL.createObjectURL
    await acquireMediaSrc(SRC, 'image')
    expect(blobs[0].type).toBe('image/webp')
  })

  it('同一地址并发取只问主进程一次;先后取也命中缓存', async () => {
    const [a, b] = await Promise.all([acquireMediaSrc(SRC, 'image'), acquireMediaSrc(SRC, 'image')])
    const c = await acquireMediaSrc(SRC, 'image')
    expect(a).toBe(b)
    expect(c).toBe(a)
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
  })

  it('不同地址各问一次', async () => {
    await Promise.all([acquireMediaSrc(SRC, 'image'), acquireMediaSrc(toRemoteThumbSrc('https://cdn.example.com/other.png'), 'image')])
    expect(readMediaThumb).toHaveBeenCalledTimes(2)
  })

  it('引用计数:最后一个持有者放手才 revoke', async () => {
    const [url] = await Promise.all([acquireMediaSrc(SRC, 'image'), acquireMediaSrc(SRC, 'image')])
    releaseMediaSrc(SRC, 'image')
    expect(revoked).toEqual([])
    releaseMediaSrc(SRC, 'image')
    expect(revoked).toEqual([url])
  })

  it('主进程说不行(ok:false)→ null,且不缓存:下一次重新问', async () => {
    let up = false
    install(() => (up ? { ok: true, base64: 'AAA', mime: 'image/jpeg' } : { ok: false, reason: 'url: HTTP 403' }))
    expect(await acquireMediaSrc(SRC, 'image')).toBeNull()
    up = true
    expect(await acquireMediaSrc(SRC, 'image')).toBe('blob:thumb-1')
    expect(readMediaThumb).toHaveBeenCalledTimes(2)
  })

  it('没有主进程通道 → null(绝不把原图地址透传给 <img>)', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    expect(await acquireMediaSrc(SRC, 'image')).toBeNull()
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { attachments: { readThumb: vi.fn() } }
    expect(await acquireMediaSrc(SRC, 'image')).toBeNull()
  })

  it('remote-thumb: 后面是空的 → 当成普通透传源(不去问主进程)', async () => {
    expect(await acquireMediaSrc('remote-thumb:', 'image')).toBe('remote-thumb:')
    expect(readMediaThumb).not.toHaveBeenCalled()
  })

  it('释放一个没取过的源 / 直通源不会炸', () => {
    expect(() => releaseMediaSrc(SRC, 'image')).not.toThrow()
    expect(() => releaseMediaSrc('https://x/a.png', 'image')).not.toThrow()
  })
})

describe('resolveMediaSrcOnce(remote-thumb:…)', () => {
  it('同样走主进程缩略,调用方自己持有 blob', async () => {
    expect(await resolveMediaSrcOnce(SRC, 'image')).toBe('blob:thumb-1')
    expect(readMediaThumb).toHaveBeenCalledWith({ url: ORIGINAL, size: undefined })
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('失败 → null', async () => {
    install(() => ({ ok: false, reason: 'nope' }))
    expect(await resolveMediaSrcOnce(SRC, 'image')).toBeNull()
  })
})
