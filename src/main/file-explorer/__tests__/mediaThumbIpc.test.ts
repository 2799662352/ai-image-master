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
 *   5. `nativeImage.createThumbnailFromPath` is tried first as a fast path
 *      (uses OS thumbnail provider — Quick Look on macOS, Shell IThumbnail
 *      on Windows), and sharp is the fallback when native says no.
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
  it('returns a JPEG much smaller than the source PNG when nativeImage succeeds', async () => {
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

    const sourceBytes = (await fs.stat(pngPath)).size
    const res = await handleMediaThumb({ path: pngPath, size: 256 })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mime).toBe('image/jpeg')
    expect(res.width).toBe(256)
    expect(res.height).toBe(256)
    const thumbBytes = Buffer.from(res.base64, 'base64').length
    expect(thumbBytes).toBeLessThan(sourceBytes / 4)
    expect(nativeImageThumbMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to sharp when nativeImage returns an empty image', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    nativeImageThumbMock.mockResolvedValueOnce({
      isEmpty: () => true,
      toJPEG: () => Buffer.alloc(0),
      getSize: () => ({ width: 0, height: 0 }),
    })

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
  })

  it('falls back to sharp when nativeImage throws (mac error path)', async () => {
    const { handleMediaThumb } = await import('../mediaThumbIpc')
    nativeImageThumbMock.mockRejectedValueOnce(new Error('NSImage rep generation failed'))

    const res = await handleMediaThumb({ path: pngPath, size: 256 })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mime).toBe('image/jpeg')
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
    nativeImageThumbMock.mockResolvedValueOnce({
      isEmpty: () => true,
      toJPEG: () => Buffer.alloc(0),
      getSize: () => ({ width: 0, height: 0 }),
    })
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
