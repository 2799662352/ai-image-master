/**
 * mediaThumbIpc 的远程 / 内联分支 —— `media:thumb` 传 `url` 而不是 `path`。
 *
 * 要钉死的是「缩略图位置永远拿不到原图」这件事在主进程这一侧的全部保证:
 *  1. 只收 `https://`(过内网地址检查)和 `data:image/…;base64`;`path` 与 `url` 各走各的闸,
 *     `url` 不能变成绕过路径白名单的后门;
 *  2. 下载一次、缩成小图(不透明 → JPEG,带透明 → WebP),渲染端只拿到几 KB;
 *  3. 同一地址再来不再下载(缓存),并发的同一地址合并成一次下载,失败不缓存;
 *  4. 远程有自己的并发闸,慢链接堵不住本地缩略图;
 *  5. 什么坏输入都不抛,统一回 `{ ok:false, reason }`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  nativeImage: { createThumbnailFromPath: vi.fn(async () => null) },
  // 故意不给 `net`:测试都走注入的 fetch,真去碰 net 就是漏注入。
}))
vi.mock('../videoFrame', () => ({ grabVideoFrame: vi.fn(async () => null) }))

import { ipcMain } from 'electron'

type Headers = Record<string, string>
function response(bytes: Buffer, headers: Headers = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    arrayBuffer: vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
  }
}

/** 噪声图:压缩后体积大,缩小后才看得出差别。 */
async function bigJpeg(width = 2000, height = 1500): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

let source: Buffer
beforeEach(async () => {
  source = await bigJpeg()
  const { resetThumbCacheForTest } = await import('../mediaThumbIpc')
  resetThumbCacheForTest()
})

const URL_A = 'https://img.example.com/full/a.jpg'

describe('远程分支 — 正常路径', () => {
  it('下载 → 缩成小 JPEG:最长边 ≤ 请求尺寸,体积远小于原图,fetch 只调一次', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const fetch = vi.fn(async () => response(source, { 'content-type': 'image/jpeg' }))
    const res = await handleMediaThumb({ url: URL_A, size: 256 }, { fetch })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mime).toBe('image/jpeg')
    expect(Math.max(res.width ?? 0, res.height ?? 0)).toBeLessThanOrEqual(256)
    expect(Buffer.from(res.base64, 'base64').length).toBeLessThan(source.length / 20)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(URL_A)
  })

  it('最终字节真的是一张小图(重新解码核对尺寸,不信返回的 width/height)', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ url: URL_A, size: 128 }, { fetch: async () => response(source) })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const meta = await sharp(Buffer.from(res.base64, 'base64')).metadata()
    expect(meta.format).toBe('jpeg')
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(128)
  })

  it('不放大:原图比请求尺寸小就保持原尺寸', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const small = await bigJpeg(100, 60)
    const res = await handleMediaThumb({ url: URL_A, size: 512 }, { fetch: async () => response(small) })
    expect(res.ok && res.width).toBe(100)
  })

  it('不透明图出 JPEG,带透明通道的出 WebP(否则透明 PNG 会被拍成黑底)', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const alphaPng = await sharp({
      create: { width: 800, height: 600, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.4 } },
    })
      .png()
      .toBuffer()
    const withAlpha = await handleMediaThumb({ url: 'https://img.example.com/alpha.png' }, { fetch: async () => response(alphaPng) })
    expect(withAlpha.ok && withAlpha.mime).toBe('image/webp')
    if (withAlpha.ok) {
      const meta = await sharp(Buffer.from(withAlpha.base64, 'base64')).metadata()
      expect(meta.format).toBe('webp')
      expect(meta.hasAlpha).toBe(true)
    }

    const opaquePng = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer()
    const opaque = await handleMediaThumb({ url: 'https://img.example.com/opaque.png' }, { fetch: async () => response(opaquePng) })
    expect(opaque.ok && opaque.mime).toBe('image/jpeg')
  })

  it('data:image 内联图:不联网,直接缩小', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const fetch = vi.fn()
    const dataUrl = `data:image/jpeg;base64,${source.toString('base64')}`
    const res = await handleMediaThumb({ url: dataUrl, size: 200 }, { fetch })
    expect(res.ok).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    if (res.ok) expect(Math.max(res.width ?? 0, res.height ?? 0)).toBeLessThanOrEqual(200)
  })

  it('size 缺省 = 256,超过上限 = 1024', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const dflt = await handleMediaThumb({ url: 'https://img.example.com/d.jpg' }, { fetch: async () => response(source) })
    expect(dflt.ok && Math.max(dflt.width ?? 0, dflt.height ?? 0)).toBe(256)
    const huge = await handleMediaThumb({ url: 'https://img.example.com/h.jpg', size: 99999 }, { fetch: async () => response(source) })
    expect(huge.ok && Math.max(huge.width ?? 0, huge.height ?? 0)).toBe(1024)
  })
})

describe('远程分支 — 拒绝(并且根本不去联网)', () => {
  it.each([
    ['http://img.example.com/a.png', 'only https'],
    ['file:///C:/Users/x/a.png', 'url:'],
    ['local-file:///C:/Users/x/a.png', 'url:'],
    ['C:\\Users\\x\\a.png', 'url:'],
    ['/etc/passwd', 'url:'],
    ['blob:https://x/uuid', 'url:'],
    ['data:text/html;base64,PGgxPmhpPC9oMT4=', 'url:'],
    ['data:image/png,notbase64', 'url:'],
    ['https://127.0.0.1/a.png', 'private address'],
    ['https://192.168.0.10/a.png', 'private address'],
    ['https://169.254.169.254/latest/meta-data/', 'private address'],
    ['https://localhost/a.png', 'local host'],
    ['https://[::1]/a.png', 'private address'],
    ['https://2130706433/a.png', 'private address'],
    ['https://user:pw@img.example.com/a.png', 'credentials'],
  ])('%s', async (url, reasonPart) => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const fetch = vi.fn()
    const res = await handleMediaThumb({ url }, { fetch })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain(reasonPart)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('`url` 不是绕过路径白名单的后门:有 path 就只认 path,path 被拒时也不会去取 url', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-remote-'))
    try {
      const txt = path.join(tmp, 'secret.txt')
      await fs.writeFile(txt, 'nope', 'utf8')
      const fetch = vi.fn()
      const res = await handleMediaThumb({ path: txt, url: URL_A }, { fetch })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain('mime whitelist')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('既没有 path 也没有 url → 原来的 empty path 错误', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    for (const args of [{}, { url: '' }, { path: '', url: '' }, { url: 123 as unknown as string }]) {
      const res = await handleMediaThumb(args, { fetch: vi.fn() })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe('whitelist: empty path')
    }
  })
})

describe('远程分支 — 错误都变成 { ok:false },不抛', () => {
  it('HTTP 4xx / 5xx', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ url: URL_A }, { fetch: async () => response(Buffer.alloc(0), {}, 403) })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('403')
  })

  it('fetch 自己抛(断网 / 超时 / 被代理掐断)', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb(
      { url: URL_A },
      {
        fetch: async () => {
          throw new Error('net::ERR_CONNECTION_RESET')
        },
      },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('ERR_CONNECTION_RESET')
  })

  it('下载到的不是图:ok:false,不抛', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ url: URL_A }, { fetch: async () => response(Buffer.from('<html>not an image</html>')) })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('thumbnail failed')
  })

  it('声明的 Content-Length 超过上限:不读 body 就放弃', async () => {
    const { handleMediaThumb, MAX_REMOTE_THUMB_SOURCE_BYTES } = await import('../mediaThumbIpc')
    const r = response(source, { 'content-length': String(MAX_REMOTE_THUMB_SOURCE_BYTES + 1) })
    const res = await handleMediaThumb({ url: URL_A }, { fetch: async () => r })
    expect(res.ok).toBe(false)
    expect(r.arrayBuffer).not.toHaveBeenCalled()
  })

  it('没声明长度、实际超过上限:读完后放弃', async () => {
    const { handleMediaThumb, MAX_REMOTE_THUMB_SOURCE_BYTES } = await import('../mediaThumbIpc')
    const big = Buffer.alloc(MAX_REMOTE_THUMB_SOURCE_BYTES + 1)
    const res = await handleMediaThumb({ url: URL_A }, { fetch: async () => response(big) })
    expect(res.ok).toBe(false)
  })

  it('data: 图坏掉', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ url: 'data:image/png;base64,AAAAAAAA' }, { fetch: vi.fn() })
    expect(res.ok).toBe(false)
  })
})

describe('远程分支 — 缓存 / 合并 / 并发', () => {
  it('同一地址同一尺寸:第二次不再下载', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const fetch = vi.fn(async () => response(source))
    const a = await handleMediaThumb({ url: URL_A, size: 256 }, { fetch })
    const b = await handleMediaThumb({ url: URL_A, size: 256 }, { fetch })
    expect(a.ok && b.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    if (a.ok && b.ok) expect(b.base64).toBe(a.base64)
  })

  it('尺寸不同 = 不同的缩略图,各下一次', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const fetch = vi.fn(async () => response(source))
    await handleMediaThumb({ url: URL_A, size: 128 }, { fetch })
    await handleMediaThumb({ url: URL_A, size: 256 }, { fetch })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('地址不同(哪怕只差签名参数)= 不同的图,各下一次', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const fetch = vi.fn(async () => response(source))
    await handleMediaThumb({ url: `${URL_A}?sig=1` }, { fetch })
    await handleMediaThumb({ url: `${URL_A}?sig=2` }, { fetch })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('同一地址的并发请求合并成一次下载', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetch = vi.fn(async () => {
      await gate
      return response(source)
    })
    const p = [1, 2, 3].map(() => handleMediaThumb({ url: URL_A }, { fetch }))
    release()
    const all = await Promise.all(p)
    expect(all.every((r) => r.ok)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('失败不缓存:下一次还能重试', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(Buffer.alloc(0), {}, 503))
      .mockResolvedValueOnce(response(source))
    const first = await handleMediaThumb({ url: URL_A }, { fetch })
    const second = await handleMediaThumb({ url: URL_A }, { fetch })
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('远程下载同时最多 REMOTE_THUMB_CONCURRENCY 个,其余排队,最后全部完成', async () => {
    const { handleMediaThumb, REMOTE_THUMB_CONCURRENCY } = await import('../mediaThumbIpc')
    // 取值本身也钉住:下面都是拿这个常量当基准,常量被改小(比如 1)时,「最多 N 个」照样成立,
    // 但滚动时远程缩略图会一张张串行出来。4 = 与本地闸同档,远程那条耗时主要在等网络。
    expect(REMOTE_THUMB_CONCURRENCY).toBe(4)
    let inflight = 0
    let peak = 0
    const releases: Array<() => void> = []
    const fetch = vi.fn(async () => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise<void>((r) => releases.push(r))
      inflight--
      return response(source)
    })
    const results = Array.from({ length: 10 }, (_, i) =>
      handleMediaThumb({ url: `https://img.example.com/many/${i}.jpg` }, { fetch }),
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(REMOTE_THUMB_CONCURRENCY))
    expect(peak).toBe(REMOTE_THUMB_CONCURRENCY)
    // 逐个放行,排队的才会陆续开始。
    while (releases.length > 0 || fetch.mock.calls.length < 10) {
      releases.shift()?.()
      await new Promise((r) => setTimeout(r, 5))
    }
    const all = await Promise.all(results)
    expect(all.every((r) => r.ok)).toBe(true)
    expect(peak).toBe(REMOTE_THUMB_CONCURRENCY)
    expect(fetch).toHaveBeenCalledTimes(10)
  })

  it('data: 内联图也排同一个远程闸(解码 + 缩小不能绕过并发上限)', async () => {
    const { handleMediaThumb, REMOTE_THUMB_CONCURRENCY } = await import('../mediaThumbIpc')
    const stuck: Array<() => void> = []
    const fetch = vi.fn(async () => {
      await new Promise<void>((r) => stuck.push(r))
      return response(source)
    })
    const slow = Array.from({ length: REMOTE_THUMB_CONCURRENCY }, (_, i) =>
      handleMediaThumb({ url: `https://img.example.com/hold/${i}.jpg` }, { fetch }),
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(REMOTE_THUMB_CONCURRENCY))

    let settled = false
    const inline = handleMediaThumb({ url: `data:image/jpeg;base64,${source.toString('base64')}`, size: 64 }, { fetch }).then((r) => {
      settled = true
      return r
    })
    // 闸被占满:内联图要排队,不会立刻出结果(闸没限住它的话,它几十毫秒内就出来了)。
    await new Promise((r) => setTimeout(r, 300))
    expect(settled).toBe(false)

    stuck.shift()?.() // 放走一个,腾出一个位置
    const res = await inline
    expect(res.ok).toBe(true)
    // 收尾:放走剩下的
    while (stuck.length > 0) {
      stuck.shift()?.()
      await new Promise((r) => setTimeout(r, 5))
    }
    await Promise.all(slow)
  })

  it('data: 内联图不进结果缓存(缓存键会带上整串几 MB 的 base64,而预算只按结果体积算)', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const dataUrl = `data:image/jpeg;base64,${source.toString('base64')}`
    const first = await handleMediaThumb({ url: dataUrl, size: 64 })
    const second = await handleMediaThumb({ url: dataUrl, size: 64 })
    expect(first.ok && second.ok).toBe(true)
    // 命中缓存会原样返回同一个对象;没缓存每次都是重新缩出来的新对象,内容一样。
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  })

  it('远程慢链接占满远程闸时,本地缩略图照常出(两个闸互不堵)', async () => {
    const { handleMediaThumb, REMOTE_THUMB_CONCURRENCY } = await import('../mediaThumbIpc')
    const stuck: Array<() => void> = []
    const fetch = vi.fn(async () => {
      await new Promise<void>((r) => stuck.push(r))
      return response(source)
    })
    const remote = Array.from({ length: REMOTE_THUMB_CONCURRENCY + 2 }, (_, i) =>
      handleMediaThumb({ url: `https://img.example.com/slow/${i}.jpg` }, { fetch }),
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(REMOTE_THUMB_CONCURRENCY))

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-remote-local-'))
    try {
      const local = path.join(tmp, 'local.png')
      await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(local)
      const res = await handleMediaThumb({ path: local, size: 64 })
      expect(res.ok).toBe(true)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
      while (stuck.length > 0 || fetch.mock.calls.length < REMOTE_THUMB_CONCURRENCY + 2) {
        stuck.shift()?.()
        await new Promise((r) => setTimeout(r, 5))
      }
      await Promise.all(remote)
    }
  })
})

describe('registerMediaThumbIpc 的包装', () => {
  afterEach(() => vi.mocked(ipcMain.handle).mockClear())

  it('只给 url 时,空 path 不能被 normalize 成 "." 而当成一个本地路径', async () => {
    const { registerMediaThumbIpc } = await import('../mediaThumbIpc')
    registerMediaThumbIpc()
    const call = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === 'media:thumb')
    expect(call).toBeTruthy()
    const handler = call![1] as (e: unknown, args: unknown) => Promise<{ ok: boolean; reason?: string }>

    // 走远程分支(被内网检查拒绝)——如果误入了路径分支,reason 会是 mime whitelist。
    const viaUrl = await handler({}, { url: 'https://127.0.0.1/a.png' })
    expect(viaUrl.ok).toBe(false)
    expect(viaUrl.reason).toBe('url: private address')

    const viaEmptyPath = await handler({}, { path: '', url: 'https://127.0.0.1/a.png' })
    expect(viaEmptyPath.reason).toBe('url: private address')
  })

  it('什么都不给也不抛', async () => {
    const { registerMediaThumbIpc } = await import('../mediaThumbIpc')
    registerMediaThumbIpc()
    const call = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === 'media:thumb')
    const handler = call![1] as (e: unknown, args: unknown) => Promise<{ ok: boolean; reason?: string }>
    for (const args of [undefined, null, {}, 'str', 42]) {
      const res = await handler({}, args)
      expect(res.ok).toBe(false)
    }
  })
})
