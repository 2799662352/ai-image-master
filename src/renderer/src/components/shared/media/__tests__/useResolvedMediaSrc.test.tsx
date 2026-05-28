/**
 * useResolvedMediaSrc — PR-A renderer hot-path tests.
 *
 * The contract this hook now enforces:
 *
 *   - DEFAULT (no opts.fullFidelity): the hook calls `electronAPI.attachments
 *     .readMediaThumb({ path, size })` first. This is the new `media:thumb`
 *     IPC that returns a ~5–30 KB JPEG instead of the full file. The renderer's
 *     event-loop budget on a chat-bar drop should now be tiny.
 *
 *   - FULL FIDELITY (opts.fullFidelity = true): the hook bypasses the
 *     thumbnail IPC and goes straight to `attachments.readThumb(path)`, which
 *     ships the original bytes. Required for the lightbox (zooming a 256px
 *     JPEG would look terrible) and any future "Save As / Copy" surface.
 *
 *   - VIDEO graceful fallback: `media:thumb` doesn't support video in PR-A
 *     (no frame extraction). When the IPC responds `{ ok: false; reason:
 *     'video thumbnail not yet supported' }` the hook falls back to
 *     `readThumb` automatically so video previews keep working.
 *
 *   - PASSTHROUGH URLs (http(s), blob, data): never routed through either
 *     IPC. The renderer hands them straight to Chromium.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResolvedMediaSrc } from '../useResolvedMediaSrc'

const readMediaThumb = vi.fn()
const readThumb = vi.fn()

beforeEach(() => {
  readMediaThumb.mockReset()
  readThumb.mockReset()
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: {
      readMediaThumb,
      readThumb,
    },
  }
  // Stub Blob URL plumbing — jsdom returns a stable counter URL.
  let n = 0
  ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (
    _b: Blob,
  ) => `blob:stub-${++n}`
  ;(globalThis.URL as unknown as { revokeObjectURL: (s: string) => void }).revokeObjectURL = () => {}
})

afterEach(() => {
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
})

describe('useResolvedMediaSrc — default (thumbnail hot path)', () => {
  it('routes local-file URIs through readMediaThumb instead of readThumb', async () => {
    readMediaThumb.mockResolvedValue({
      ok: true,
      base64: Buffer.from('jpeg-bytes').toString('base64'),
      mime: 'image/jpeg',
      width: 256,
      height: 256,
    })

    const { result } = renderHook(() =>
      useResolvedMediaSrc('local-file:///D%3A/photos/cat.png', 'image'),
    )

    await waitFor(() => expect(result.current?.startsWith('blob:')).toBe(true))
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    // The hook leaves the resolved path in its decoded form (forward
    // slashes survive from the URL); main process normalizes via
    // `path.normalize` inside registerMediaThumbIpc.
    expect(readMediaThumb).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'D:/photos/cat.png' }),
    )
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('routes raw Windows OS paths through readMediaThumb', async () => {
    readMediaThumb.mockResolvedValue({
      ok: true,
      base64: Buffer.from('jpeg-bytes').toString('base64'),
      mime: 'image/jpeg',
    })

    const { result } = renderHook(() => useResolvedMediaSrc('D:\\photos\\dog.png', 'image'))

    await waitFor(() => expect(result.current?.startsWith('blob:')).toBe(true))
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('falls back to readThumb when readMediaThumb says "video not supported"', async () => {
    readMediaThumb.mockResolvedValue({ ok: false, reason: 'video thumbnail not yet supported' })
    readThumb.mockResolvedValue({
      ok: true,
      base64: Buffer.from('mp4-bytes').toString('base64'),
      mime: 'video/mp4',
    })

    const { result } = renderHook(() => useResolvedMediaSrc('D:\\videos\\reel.mp4', 'video'))

    await waitFor(() => expect(result.current?.startsWith('blob:')).toBe(true))
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(readThumb).toHaveBeenCalledTimes(1)
  })

  it('does not invoke any IPC for http(s):// URLs (Chromium native loader)', async () => {
    const { result } = renderHook(() =>
      useResolvedMediaSrc('https://cdn.example.com/cat.png', 'image'),
    )
    await waitFor(() => expect(result.current).toBe('https://cdn.example.com/cat.png'))
    expect(readMediaThumb).not.toHaveBeenCalled()
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('does not invoke any IPC for blob: URLs (already a renderable blob)', async () => {
    const { result } = renderHook(() => useResolvedMediaSrc('blob:abc-123', 'image'))
    await waitFor(() => expect(result.current).toBe('blob:abc-123'))
    expect(readMediaThumb).not.toHaveBeenCalled()
    expect(readThumb).not.toHaveBeenCalled()
  })
})

describe('useResolvedMediaSrc — opts.fullFidelity (lightbox / download path)', () => {
  it('skips readMediaThumb and goes straight to readThumb when fullFidelity is true', async () => {
    readThumb.mockResolvedValue({
      ok: true,
      base64: Buffer.from('full-bytes').toString('base64'),
      mime: 'image/png',
    })

    const { result } = renderHook(() =>
      useResolvedMediaSrc('local-file:///D%3A/photos/cat.png', 'image', { fullFidelity: true }),
    )

    await waitFor(() => expect(result.current?.startsWith('blob:')).toBe(true))
    expect(readMediaThumb).not.toHaveBeenCalled()
    expect(readThumb).toHaveBeenCalledTimes(1)
    expect(readThumb).toHaveBeenCalledWith('D:/photos/cat.png')
  })
})
