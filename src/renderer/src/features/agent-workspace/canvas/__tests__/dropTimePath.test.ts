import { afterEach, describe, expect, it, vi } from 'vitest'
import { insertFilePlaceholder, makeFileAssetHandlerWithDiskPath, makeFilesContentHandlerWithPlaceholders } from '../shapeOps'
import { canvasBridge } from '../canvasBridge'

// AI-Canvas "path at creation": an OS-desktop-dropped image/video must get a real
// on-disk path baked into asset.meta.assetPath AT DROP TIME, so the path shows up
// natively in canvas_snapshot / get_selected_canvas_video without the agent
// calling get_canvas_video. Two pieces are tested here:
//   1. makeFileAssetHandlerWithDiskPath — the pure wrapper around tldraw's default
//      'file' asset handler (delegate, then merge meta.assetPath).
//   2. canvasBridge.resolveDroppedFileDiskPath — real OS path (electronAPI
//      .getFilePath, zero copy) first, base64 → attachments.save only as fallback.

describe('makeFileAssetHandlerWithDiskPath (wrap tldraw default file handler)', () => {
  const info = { type: 'file' as const, file: new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' }) }

  it('bakes the persisted disk path into a video asset meta (default handler untouched)', async () => {
    const defaultHandler = vi.fn(async () => ({ type: 'video', meta: { name: 'clip.mp4' } }))
    const persist = vi.fn(async () => 'D:/agent/uploads/clip.mp4')
    const handler = makeFileAssetHandlerWithDiskPath(defaultHandler, persist, () => 't1')

    const asset = await handler(info)

    expect(defaultHandler).toHaveBeenCalledWith(info)
    expect(persist).toHaveBeenCalledWith(info.file, 't1')
    // Original meta preserved + assetPath merged in.
    expect(asset).toEqual({ type: 'video', meta: { name: 'clip.mp4', assetPath: 'D:/agent/uploads/clip.mp4' } })
  })

  it('also handles image assets', async () => {
    const defaultHandler = vi.fn(async () => ({ type: 'image', meta: {} }))
    const persist = vi.fn(async () => 'D:/agent/uploads/pic.png')
    const handler = makeFileAssetHandlerWithDiskPath(defaultHandler, persist, () => 't1')
    const asset = (await handler(info)) as { meta: Record<string, unknown> }
    expect(asset.meta.assetPath).toBe('D:/agent/uploads/pic.png')
  })

  it('returns the plain asset when persist yields no path (e.g. too large / no IPC)', async () => {
    const defaultHandler = vi.fn(async () => ({ type: 'video', meta: { name: 'clip.mp4' } }))
    const persist = vi.fn(async () => undefined)
    const handler = makeFileAssetHandlerWithDiskPath(defaultHandler, persist, () => 't1')
    const asset = (await handler(info)) as { meta: Record<string, unknown> }
    expect(asset.meta).toEqual({ name: 'clip.mp4' })
    expect(asset.meta.assetPath).toBeUndefined()
  })

  it('skips persistence entirely for non-media asset types', async () => {
    const defaultHandler = vi.fn(async () => ({ type: 'bookmark', meta: {} }))
    const persist = vi.fn(async () => 'D:/should/not/happen')
    const handler = makeFileAssetHandlerWithDiskPath(defaultHandler, persist, () => 't1')
    const asset = (await handler(info)) as { type: string; meta: Record<string, unknown> }
    expect(persist).not.toHaveBeenCalled()
    expect(asset.meta.assetPath).toBeUndefined()
  })

  it('skips persistence when there is no active thread', async () => {
    const defaultHandler = vi.fn(async () => ({ type: 'video', meta: {} }))
    const persist = vi.fn(async () => 'D:/nope')
    const handler = makeFileAssetHandlerWithDiskPath(defaultHandler, persist, () => undefined)
    await handler(info)
    expect(persist).not.toHaveBeenCalled()
  })

  it('is non-fatal: a thrown persist must not block the drop', async () => {
    const defaultHandler = vi.fn(async () => ({ type: 'video', meta: { name: 'clip.mp4' } }))
    const persist = vi.fn(async () => {
      throw new Error('disk full')
    })
    const handler = makeFileAssetHandlerWithDiskPath(defaultHandler, persist, () => 't1')
    const asset = (await handler(info)) as { meta: Record<string, unknown> }
    expect(asset.meta).toEqual({ name: 'clip.mp4' })
  })

  it('passes through undefined when the default handler yields nothing', async () => {
    const persist = vi.fn(async () => 'D:/nope')
    const handler = makeFileAssetHandlerWithDiskPath(async () => undefined, persist, () => 't1')
    expect(await handler(info)).toBeUndefined()
    expect(persist).not.toHaveBeenCalled()
  })

  it('passes through undefined when there is no default handler', async () => {
    const handler = makeFileAssetHandlerWithDiskPath(null, vi.fn(async () => 'x'), () => 't1')
    expect(await handler(info)).toBeUndefined()
  })
})

describe('canvasBridge.resolveDroppedFileDiskPath (real OS path first, copy fallback)', () => {
  afterEach(() => {
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('PREFERS the real OS path (zero copy) and never copies bytes — any type/size', async () => {
    const save = vi.fn()
    const getFilePath = vi.fn(() => 'D:/Desktop/song.mp3')
    ;(window as { electronAPI?: unknown }).electronAPI = { getFilePath, attachments: { save } }
    // An audio File the copy-fallback would REJECT (mime not image/video) + a huge
    // size the base64 cap would reject — both irrelevant: OS path wins outright.
    const mp3 = { size: 999 * 1024 * 1024, name: 'song.mp3', type: 'audio/mpeg' } as unknown as File

    expect(await canvasBridge.resolveDroppedFileDiskPath(mp3, 't1')).toBe('D:/Desktop/song.mp3')
    expect(getFilePath).toHaveBeenCalledWith(mp3)
    expect(save).not.toHaveBeenCalled()
  })

  it('OS path works even without a thread (no copy needed)', async () => {
    const getFilePath = vi.fn(() => 'D:/Desktop/archive.zip')
    ;(window as { electronAPI?: unknown }).electronAPI = { getFilePath }
    const zip = new File([new Uint8Array([1])], 'archive.zip', { type: 'application/zip' })
    expect(await canvasBridge.resolveDroppedFileDiskPath(zip, '')).toBe('D:/Desktop/archive.zip')
  })

  it('falls back to copy when getFilePath is empty (synthetic/clipboard File)', async () => {
    const save = vi.fn(async () => ({ ok: true as const, path: 'C:/agent/uploads/clip.mp4' }))
    const getFilePath = vi.fn(() => '')
    ;(window as { electronAPI?: unknown }).electronAPI = { getFilePath, attachments: { save } }
    const file = new File([new Uint8Array([65, 66, 67])], 'clip.mp4', { type: 'video/mp4' })

    const path = await canvasBridge.resolveDroppedFileDiskPath(file, 't1')

    expect(path).toBe('C:/agent/uploads/clip.mp4')
    expect(save).toHaveBeenCalledWith({ threadId: 't1', name: 'clip.mp4', mime: 'video/mp4', base64: 'QUJD' })
  })

  it('saves a small video File and returns its disk path (no getFilePath available)', async () => {
    const save = vi.fn(async () => ({ ok: true as const, path: 'C:/agent/uploads/clip.mp4' }))
    ;(window as { electronAPI?: unknown }).electronAPI = { attachments: { save } }
    const file = new File([new Uint8Array([65, 66, 67])], 'clip.mp4', { type: 'video/mp4' })

    const path = await canvasBridge.resolveDroppedFileDiskPath(file, 't1')

    expect(path).toBe('C:/agent/uploads/clip.mp4')
    expect(save).toHaveBeenCalledWith({ threadId: 't1', name: 'clip.mp4', mime: 'video/mp4', base64: 'QUJD' })
  })

  it('derives a video mime from the extension when File.type is empty (copy fallback)', async () => {
    const save = vi.fn(async () => ({ ok: true as const, path: 'C:/u/clip.webm' }))
    ;(window as { electronAPI?: unknown }).electronAPI = { attachments: { save } }
    const file = new File([new Uint8Array([65, 66, 67])], 'clip.webm', { type: '' })

    await canvasBridge.resolveDroppedFileDiskPath(file, 't1')

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ mime: 'video/webm' }))
  })

  it('skips files past the in-memory base64 cap when there is no OS path', async () => {
    const save = vi.fn()
    ;(window as { electronAPI?: unknown }).electronAPI = { attachments: { save } }
    const huge = { size: 200 * 1024 * 1024, name: 'big.mp4', type: 'video/mp4' } as unknown as File

    expect(await canvasBridge.resolveDroppedFileDiskPath(huge, 't1')).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('cannot copy a non-media file without an OS path (fallback is media-only)', async () => {
    const save = vi.fn()
    ;(window as { electronAPI?: unknown }).electronAPI = { attachments: { save } }
    const txt = new File([new Uint8Array([1])], 'notes.txt', { type: 'text/plain' })
    expect(await canvasBridge.resolveDroppedFileDiskPath(txt, 't1')).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('returns undefined without a thread when only the copy fallback is possible', async () => {
    const file = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' })
    expect(await canvasBridge.resolveDroppedFileDiskPath(file, '')).toBeUndefined()
  })

  it('returns undefined when the save IPC reports failure', async () => {
    const save = vi.fn(async () => ({ ok: false as const, reason: 'quota' }))
    ;(window as { electronAPI?: unknown }).electronAPI = { attachments: { save } }
    const file = new File([new Uint8Array([65])], 'clip.mp4', { type: 'video/mp4' })
    expect(await canvasBridge.resolveDroppedFileDiskPath(file, 't1')).toBeUndefined()
  })
})

// Minimal fake editor for shape-creating helpers (camera APIs absent → zoom no-op).
function makeFakeEditor(): { editor: any; shapes: any[] } {
  const shapes: any[] = []
  const editor = {
    getShapePageBounds: () => ({ x: 0, y: 0, w: 100, h: 100 }),
    createShape: (shape: unknown) => shapes.push(shape),
    bringToFront: () => {},
    select: () => {},
    run: (fn: () => void) => fn(),
  }
  return { editor, shapes }
}

describe('insertFilePlaceholder (path-bearing file-card for non-renderable files)', () => {
  it('creates a file-card shape whose props+meta carry assetPath + audio kind', () => {
    const { editor, shapes } = makeFakeEditor()
    insertFilePlaceholder(editor, { assetPath: 'D:/a/song.mp3', title: 'song.mp3', kind: 'audio', x: 10, y: 20 })
    const card = shapes.find((s) => s.type === 'file-card')
    expect(card.props.kind).toBe('audio')
    expect(card.props.title).toBe('song.mp3')
    expect(card.props.assetPath).toBe('D:/a/song.mp3')
    expect(card.meta.assetKind).toBe('audio')
    expect(card.meta.assetPath).toBe('D:/a/song.mp3')
    expect(card.meta.aiCanvasRole).toBe('dropped_audio')
  })

  it('still drops a (path-less) card when no disk path could be resolved', () => {
    const { editor, shapes } = makeFakeEditor()
    insertFilePlaceholder(editor, { title: 'mystery.bin', kind: 'file' })
    const card = shapes.find((s) => s.type === 'file-card')
    expect(card.props.assetPath).toBe('')
    expect(card.meta.assetKind).toBe('file')
    expect(card.meta.assetPath).toBeUndefined()
  })

  it('grows the card to fit the inline player for playable-src AND disk-path audio', () => {
    const { editor, shapes } = makeFakeEditor()
    insertFilePlaceholder(editor, { title: 'a.mp3', kind: 'audio', assetUrl: 'data:audio/mpeg;base64,AAA' })
    insertFilePlaceholder(editor, { title: 'p.mp3', kind: 'audio', assetPath: 'D:/music/p.mp3' })
    insertFilePlaceholder(editor, { title: 'b.mp3', kind: 'audio' })
    const [bySrc, byPath, plain] = shapes.filter((s) => s.type === 'file-card')
    expect(bySrc.props.h).toBeGreaterThan(plain.props.h)
    expect(byPath.props.h).toBeGreaterThan(plain.props.h)
  })
})

describe('makeFilesContentHandlerWithPlaceholders (OS-drop split: media vs other)', () => {
  const img = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
  const mp3 = new File([new Uint8Array([2])], 'b.mp3', { type: 'audio/mpeg' })
  const zip = new File([new Uint8Array([3])], 'c.zip', { type: 'application/zip' })
  const isMedia = (f: File): boolean => f.type.startsWith('image/') || f.type.startsWith('video/')

  it('delegates media to the default handler and routes everything else to placeholders', async () => {
    const def = vi.fn(async () => {})
    const other = vi.fn(async () => {})
    const handler = makeFilesContentHandlerWithPlaceholders(def, isMedia, other)

    await handler({ type: 'files', files: [img, mp3, zip], point: { x: 5, y: 6 } })

    expect(def).toHaveBeenCalledTimes(1)
    expect(def).toHaveBeenCalledWith({ type: 'files', files: [img], point: { x: 5, y: 6 } })
    expect(other).toHaveBeenCalledTimes(2)
    expect(other).toHaveBeenNthCalledWith(1, mp3, { x: 5, y: 6 }, 0)
    expect(other).toHaveBeenNthCalledWith(2, zip, { x: 5, y: 6 }, 1)
  })

  it('an all-media drop never touches placeholders (behaves like stock tldraw)', async () => {
    const def = vi.fn(async () => {})
    const other = vi.fn(async () => {})
    const handler = makeFilesContentHandlerWithPlaceholders(def, isMedia, other)
    await handler({ type: 'files', files: [img], point: { x: 0, y: 0 } })
    expect(def).toHaveBeenCalledWith({ type: 'files', files: [img], point: { x: 0, y: 0 } })
    expect(other).not.toHaveBeenCalled()
  })

  it('an all-other drop never calls the default handler', async () => {
    const def = vi.fn(async () => {})
    const other = vi.fn(async () => {})
    const handler = makeFilesContentHandlerWithPlaceholders(def, isMedia, other)
    await handler({ type: 'files', files: [mp3, zip] })
    expect(def).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledTimes(2)
  })

  it('isolates a failing placeholder so the rest of the batch still runs', async () => {
    const def = vi.fn(async () => {})
    const other = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const handler = makeFilesContentHandlerWithPlaceholders(def, isMedia, other)
    await handler({ type: 'files', files: [mp3, zip] })
    expect(other).toHaveBeenCalledTimes(2)
  })
})
