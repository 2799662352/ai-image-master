/**
 * mediaThumbIpc — tests for the `media:thumb` IPC handler.
 *
 * This is the renderer hot-path replacement for `attachments:read-thumb` when
 * the caller only needs a small preview (chat thumbnail, file-explorer chip,
 * reference card). Instead of base64-encoding the full file (could be 5–20 MB
 * for modern phone photos) and shipping it through `structuredClone`, this
 * handler decodes + resizes once on the main side and returns a ~5–30 KB
 * JPEG. Goal of these tests is to lock in:
 *
 *   1. Whitelist / traversal / size enforcement matches `attachments:read-thumb`
 *      (so an attacker can't get bytes through one channel that the other
 *      rejects).
 *
 *   2. Output is dramatically smaller than the source file — this is THE
 *      reason the IPC exists; if the test passes but the output is the same
 *      size as the input, the optimization is silently a no-op.
 *
 *   3. The handler does NOT throw on bad input — it always returns a
 *      `{ ok: false; reason }` envelope so the renderer can degrade
 *      gracefully without unhandled promise rejections.
 *
 *   4. SVG falls through to a raw passthrough (resizing SVG via sharp would
 *      lose the vector representation; SVGs are already small).
 *
 *   5. sharp decodes first (off the main thread, fast for freshly written
 *      files); `nativeImage.createThumbnailFromPath` (OS thumbnail provider —
 *      Quick Look on macOS, Shell IThumbnail on Windows) is the fallback for
 *      formats sharp cannot decode, and the first choice for video stills.
 *
 *   6. Generation is concurrency-limited, de-duplicated while in flight, and
 *      successful results are cached by (realpath, mtime, size, edge).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

// --- Electron mock --------------------------------------------------------
//
// `electron` cannot be imported in a plain Node process (its main export is
// the path to the binary). Existing tests in this repo follow the same
// pattern (see AttachmentService.streaming.test.ts). The mock exposes a
// controllable `nativeImage.createThumbnailFromPath` so we can drive both
// "native fast path succeeded" and "native bailed, fall back to sharp"
// branches of the handler.

const nativeImageThumbMock = vi.fn<
  (filePath: string, size: { width: number; height: number }) => Promise<{
    isEmpty: () => boolean
    toJPEG: (quality: number) => Buffer
    getSize: () => { width: number; height: number }
  }>
>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  nativeImage: {
    createThumbnailFromPath: (...args: Parameters<typeof nativeImageThumbMock>) =>
      nativeImageThumbMock(...args),
  },
}))

const grabVideoFrameMock = vi.fn<(videoPath: string, size: number) => Promise<Buffer | null>>()
vi.mock('../videoFrame', () => ({
  grabVideoFrame: (...args: [string, number]) => grabVideoFrameMock(...args),
}))

let tmpDir: string
let pngPath: string
let svgPath: string
let txtPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-thumb-'))
  // 1024x1024 PNG — large enough that a 256px thumbnail is clearly smaller.
  pngPath = path.join(tmpDir, 'photo.png')
  await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: { r: 200, g: 60, b: 60 } },
  })
    .png()
    .toFile(pngPath)

  svgPath = path.join(tmpDir, 'icon.svg')
  await fs.writeFile(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#0af"/></svg>',
    'utf8',
  )

  txtPath = path.join(tmpDir, 'secret.txt')
  await fs.writeFile(txtPath, 'should not be readable through media:thumb', 'utf8')

  nativeImageThumbMock.mockReset()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('mediaThumbIpc.handleMediaThumb — happy paths', () => {
  // 顺序是量出来的:新生成的图系统缩略图缓存不命中,系统提供者更慢、且 toJPEG 在主线程上,
  // 一次来几百张会把主进程事件循环占住几秒。所以能被 sharp 解码的图一律不碰 nativeImage。
  it('sharp 解得了的图:直接缩成小 JPEG,不去问系统缩略图提供者', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const sourceBytes = (await fs.stat(pngPath)).size
    const res = await handleMediaThumb({ path: pngPath, size: 128 })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mime).toBe('image/jpeg')
    // sharp respects withoutEnlargement so a 1024px source resized to 128
    // produces 128x128 (square source, fit=inside).
    expect(res.width).toBeLessThanOrEqual(128)
    expect(res.height).toBeLessThanOrEqual(128)
    const thumbBytes = Buffer.from(res.base64, 'base64').length
    expect(thumbBytes).toBeGreaterThan(0)
    expect(thumbBytes).toBeLessThan(sourceBytes / 4)
    expect(nativeImageThumbMock).not.toHaveBeenCalled()
  })

  // BMP / ICO 之类 sharp 解不了的格式,系统提供者是唯一的出路。
  describe('sharp 解不了的文件才退到系统缩略图提供者', () => {
    let undecodablePath: string
    beforeEach(async () => {
      undecodablePath = path.join(tmpDir, 'weird.png')
      await fs.writeFile(undecodablePath, Buffer.from('this is not an image sharp can decode'))
    })

    it('系统提供者给出图 → 用它', async () => {
      const { handleMediaThumb } = await import('../mediaThumbIpc')
      // Build a 256x256 JPEG buffer via sharp to feed the mock — emulates what
      // Electron's OS thumbnail provider would hand us back.
      const fakeNativeJpeg = await sharp({
        create: { width: 256, height: 256, channels: 3, background: { r: 200, g: 60, b: 60 } },
      })
        .jpeg({ quality: 78 })
        .toBuffer()
      nativeImageThumbMock.mockResolvedValueOnce({
        isEmpty: () => false,
        toJPEG: () => fakeNativeJpeg,
        getSize: () => ({ width: 256, height: 256 }),
      })

      const res = await handleMediaThumb({ path: undecodablePath, size: 256 })

      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.mime).toBe('image/jpeg')
      expect(res.width).toBe(256)
      expect(res.height).toBe(256)
      expect(nativeImageThumbMock).toHaveBeenCalledTimes(1)
    })

    it('系统提供者回空图 → 失败,reason 带 sharp 的原因', async () => {
      const { handleMediaThumb } = await import('../mediaThumbIpc')
      nativeImageThumbMock.mockResolvedValueOnce({
        isEmpty: () => true,
        toJPEG: () => Buffer.alloc(0),
        getSize: () => ({ width: 0, height: 0 }),
      })
      const res = await handleMediaThumb({ path: undecodablePath, size: 128 })
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toMatch(/thumbnail failed/)
    })

    it('系统提供者抛错(mac 的错误路径)→ 失败而不是抛出', async () => {
      const { handleMediaThumb } = await import('../mediaThumbIpc')
      nativeImageThumbMock.mockRejectedValueOnce(new Error('NSImage rep generation failed'))
      const res = await handleMediaThumb({ path: undecodablePath, size: 256 })
      expect(res.ok).toBe(false)
    })
  })

  it('passes SVG through unchanged (skips both nativeImage and sharp resize)', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ path: svgPath, size: 256 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mime).toBe('image/svg+xml')
    const decoded = Buffer.from(res.base64, 'base64').toString('utf8')
    expect(decoded).toContain('<svg')
    // Vector format — width/height undefined is acceptable since we don't
    // rasterize. Either undefined or the SVG's authored size is fine.
    expect(nativeImageThumbMock).not.toHaveBeenCalled()
  })

  it('uses a sensible default size when caller omits it', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ path: pngPath })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 256 is the design default — exact value documented in the IPC spec.
    expect(res.width).toBeLessThanOrEqual(256)
    expect(res.height).toBeLessThanOrEqual(256)
  })
})

describe('mediaThumbIpc.handleMediaThumb — rejection paths', () => {
  it('rejects non-string / empty path with whitelist:empty path', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ path: '' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/empty|whitelist/i)
  })

  it('rejects paths with `..` traversal segments before touching the disk', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    // NOTE: build the path by raw concatenation — `path.join(a, '..', b)`
    // would normalize the `..` away on Node, hiding the segment we want
    // the IPC to reject. The renderer can absolutely send unnormalized
    // strings (URL-decoded percent-encoded paths, manual string concat),
    // so this is the actual attack surface we care about.
    const literalDotDot = `${tmpDir}${path.sep}..${path.sep}should-not-leak.png`
    const res = await handleMediaThumb({ path: literalDotDot })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/traversal/i)
  })

  it('rejects extension not on the mime whitelist (id_rsa, .txt, no ext)', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ path: txtPath })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/mime|whitelist/i)
    expect(nativeImageThumbMock).not.toHaveBeenCalled()
  })

  it('rejects missing files with file-not-found reason', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const ghost = path.join(tmpDir, 'does-not-exist.png')
    const res = await handleMediaThumb({ path: ghost })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/not found|enoent/i)
  })

  it('rejects files larger than MAX_ATTACHMENT_BYTES', async () => {
    const { handleMediaThumb, MAX_ATTACHMENT_BYTES } = await import('../mediaThumbIpc')
    const bigPath = path.join(tmpDir, 'big.png')
    // Write a file with a fake .png extension that is just oversized random
    // bytes. We don't need it to be a valid PNG; the size check runs first.
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0)
    await fs.writeFile(bigPath, oversized)
    const res = await handleMediaThumb({ path: bigPath })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/size|whitelist/i)
  })
})

// 视频工作台的参考视频以前从挂上去就只有 🎬 —— 这条通道对视频直接回「不支持」。
describe('mediaThumbIpc.handleMediaThumb — video frames', () => {
  let videoPath: string

  beforeEach(async () => {
    videoPath = path.join(tmpDir, 'clip.mp4')
    await fs.writeFile(videoPath, Buffer.from('not really a video'))
    grabVideoFrameMock.mockReset()
  })

  async function jpeg(size: number): Promise<Buffer> {
    return sharp({ create: { width: size, height: size, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer()
  }

  it('系统缩略图拿得到就用它,不启动 ffmpeg', async () => {
    const buf = await jpeg(64)
    nativeImageThumbMock.mockResolvedValue({
      isEmpty: () => false,
      toJPEG: () => buf,
      getSize: () => ({ width: 64, height: 64 }),
    })
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ path: videoPath, size: 128 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mime).toBe('image/jpeg')
    expect(grabVideoFrameMock).not.toHaveBeenCalled()
  })

  it('系统没有缩略图时用自带 ffmpeg 截一帧', async () => {
    nativeImageThumbMock.mockRejectedValue(new Error('no thumbnail provider'))
    grabVideoFrameMock.mockResolvedValue(await jpeg(96))
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ path: videoPath, size: 128 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.width).toBe(96)
    expect(grabVideoFrameMock).toHaveBeenCalledWith(expect.stringContaining('clip.mp4'), 128)
  })

  it('两条都拿不到时回失败,reason 仍带 video(渲染层据此选兜底)', async () => {
    nativeImageThumbMock.mockRejectedValue(new Error('no thumbnail provider'))
    grabVideoFrameMock.mockResolvedValue(null)
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const res = await handleMediaThumb({ path: videoPath })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/video/)
  })

  it('视频不受 MAX_ATTACHMENT_BYTES 约束 —— 只截一帧,不读整个文件', async () => {
    const { handleMediaThumb, MAX_ATTACHMENT_BYTES } = await import('../mediaThumbIpc')
    const bigVideo = path.join(tmpDir, 'long.mp4')
    const fh = await fs.open(bigVideo, 'w')
    await fh.truncate(MAX_ATTACHMENT_BYTES + 1)
    await fh.close()
    nativeImageThumbMock.mockRejectedValue(new Error('no thumbnail provider'))
    grabVideoFrameMock.mockResolvedValue(await jpeg(32))
    const res = await handleMediaThumb({ path: bigVideo })
    expect(res.ok).toBe(true)
  })
})

// 聊天里一次挂几百张本地生成图时,渲染层会一次发几百个 media:thumb。
// 这里锁住:限并发(别把主进程事件循环占住)、在途合并、成功结果缓存、失败不缓存。
describe('mediaThumbIpc.handleMediaThumb — 调度(限并发 / 合并 / 缓存)', () => {
  async function undecodable(name: string, body = 'not decodable by sharp'): Promise<string> {
    const p = path.join(tmpDir, name)
    await fs.writeFile(p, Buffer.from(body))
    return p
  }

  async function nativeOk(): Promise<{
    isEmpty: () => boolean
    toJPEG: () => Buffer
    getSize: () => { width: number; height: number }
  }> {
    const buf = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toBuffer()
    return { isEmpty: () => false, toJPEG: () => buf, getSize: () => ({ width: 8, height: 8 }) }
  }

  beforeEach(async () => {
    const { resetThumbCacheForTest } = await import('../mediaThumbIpc')
    resetThumbCacheForTest()
  })

  it('同时在生成的数量不超过 THUMB_CONCURRENCY,其余排队(但确实并行)', async () => {
    const { handleMediaThumb, THUMB_CONCURRENCY } = await import('../mediaThumbIpc')
    let running = 0
    let peak = 0
    const img = await nativeOk()
    nativeImageThumbMock.mockImplementation(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running -= 1
      return img
    })
    const files = await Promise.all(Array.from({ length: 12 }, (_, i) => undecodable(`w${i}.png`, `body ${i}`)))
    const results = await Promise.all(files.map((f) => handleMediaThumb({ path: f })))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(12)
    // 常量本身也钉住范围:光比较 peak ≤ 常量,常量被改成 1000 时测试照样绿。
    expect(THUMB_CONCURRENCY).toBeGreaterThanOrEqual(2)
    expect(THUMB_CONCURRENCY).toBeLessThanOrEqual(8)
    expect(peak).toBeLessThanOrEqual(THUMB_CONCURRENCY)
    expect(peak).toBeGreaterThanOrEqual(2)
  })

  it('同一张图的并发请求合并成一次生成', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const img = await nativeOk()
    let release: () => void = () => {}
    nativeImageThumbMock.mockImplementation(
      () => new Promise((r) => (release = () => r(img))),
    )
    const f = await undecodable('same.png')
    const a = handleMediaThumb({ path: f })
    const b = handleMediaThumb({ path: f })
    // 让两次请求都走到「在途」之后再放行。
    await new Promise((r) => setTimeout(r, 50))
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.ok && rb.ok).toBe(true)
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(1)
  })

  it('成功的结果被缓存:重复请求不再生成', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    nativeImageThumbMock.mockResolvedValue(await nativeOk())
    const f = await undecodable('cached.png')
    const first = await handleMediaThumb({ path: f, size: 64 })
    const second = await handleMediaThumb({ path: f, size: 64 })
    expect(first.ok && second.ok).toBe(true)
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(1)
    if (first.ok && second.ok) expect(second.base64).toBe(first.base64)
  })

  it('文件变了(大小 / 修改时间)缓存自动失效;换个尺寸也是另一条', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    nativeImageThumbMock.mockResolvedValue(await nativeOk())
    const f = await undecodable('changing.png', 'v1')
    await handleMediaThumb({ path: f, size: 64 })
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(1)
    await handleMediaThumb({ path: f, size: 128 })
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(2)
    await fs.writeFile(f, 'version two is longer')
    await handleMediaThumb({ path: f, size: 64 })
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(3)
  })

  it('缓存键里「大小」与「修改时间」各自独立生效:只变其一也要重新生成', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    nativeImageThumbMock.mockResolvedValue(await nativeOk())

    // 大小相同、内容不同、修改时间变了(别的工具原地覆盖了同尺寸的图)
    const a = await undecodable('same-size.png', 'AAAA')
    await handleMediaThumb({ path: a, size: 64 })
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(1)
    await fs.writeFile(a, 'BBBB')
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(a, later, later)
    await handleMediaThumb({ path: a, size: 64 })
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(2)

    // 修改时间被还原成一样、大小变了(时间戳被保留的覆盖,比如复制 / 解压工具)
    const b = await undecodable('same-mtime.png', 'AAAA')
    const stamp = new Date(Date.now() - 3_600_000)
    await fs.utimes(b, stamp, stamp)
    await handleMediaThumb({ path: b, size: 64 })
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(3)
    await fs.writeFile(b, 'AAAAAAAA')
    await fs.utimes(b, stamp, stamp)
    await handleMediaThumb({ path: b, size: 64 })
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(4)
  })

  it('失败不缓存:文件稍后能读了要能重试成功', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    const f = await undecodable('flaky.png')
    nativeImageThumbMock.mockRejectedValueOnce(new Error('still being written'))
    const first = await handleMediaThumb({ path: f })
    expect(first.ok).toBe(false)
    nativeImageThumbMock.mockResolvedValueOnce(await nativeOk())
    const second = await handleMediaThumb({ path: f })
    expect(second.ok).toBe(true)
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(2)
  })

  it('视频同样走缓存:第二次不再启动 ffmpeg', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    nativeImageThumbMock.mockRejectedValue(new Error('no thumbnail provider'))
    const frame = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .jpeg()
      .toBuffer()
    grabVideoFrameMock.mockReset()
    grabVideoFrameMock.mockResolvedValue(frame)
    const v = path.join(tmpDir, 'again.mp4')
    await fs.writeFile(v, Buffer.from('video bytes'))
    await handleMediaThumb({ path: v, size: 64 })
    await handleMediaThumb({ path: v, size: 64 })
    expect(grabVideoFrameMock).toHaveBeenCalledTimes(1)
  })
})