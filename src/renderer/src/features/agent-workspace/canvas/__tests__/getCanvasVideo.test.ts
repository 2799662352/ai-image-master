import { afterEach, describe, expect, it, vi } from 'vitest'

// readCanvasState no longer embeds getSnapshot (that cloned asset bytes).
// Keep the stub so older fakes without a store still import cleanly.
vi.mock('tldraw', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tldraw')>()
  return { ...actual, getSnapshot: () => ({}) }
})

import { canvasBridge } from '../canvasBridge'

/** Minimal fake editor exposing one selected video shape + its backing asset. */
function makeVideoEditor(opts: { assetPath?: string | null; assetSrc?: string; resolvedUrl?: string | null }): any {
  const meta: Record<string, unknown> = { aiCanvasRole: 'ai_video', title: '猫' }
  if (opts.assetPath) meta.assetPath = opts.assetPath
  const videoShape = { id: 'shape:v1', type: 'video', x: 0, y: 0, props: { assetId: 'asset:v1', w: 1280, h: 720 }, meta }
  const asset = {
    props: { src: opts.assetSrc ?? 'asset:v1', w: 1280, h: 720 },
    meta: opts.assetPath ? { assetPath: opts.assetPath } : {},
  }
  return {
    store: {},
    getCurrentPageShapes: () => [videoShape],
    getCurrentPageShapeIds: () => new Set(['shape:v1']),
    getSelectedShapeIds: () => ['shape:v1'],
    getShapePageBounds: () => ({ x: 0, y: 0, w: 1280, h: 720 }),
    getShape: () => videoShape,
    getAsset: () => asset,
    // tldraw's official asset read path: resolves an opaque `asset:` ref (bytes in
    // IndexedDB under persistenceKey) to a fetchable URL. `resolvedUrl: undefined`
    // simulates an editor build without it (falls back to props.src).
    resolveAssetUrl:
      opts.resolvedUrl === undefined ? undefined : async () => opts.resolvedUrl ?? null,
  }
}

describe('get_canvas_video: always disclose an openable local path for a canvas video', () => {
  afterEach(() => {
    canvasBridge.setEditor(null)
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('OS-dragged clip (asset: ref, no recorded path): resolves via resolveAssetUrl then materializes', async () => {
    const save = vi.fn(async () => ({ ok: true as const, path: 'C:/agent/uploads/canvas-video-2.mp4' }))
    ;(window as { electronAPI?: unknown }).electronAPI = { attachments: { save } }
    // Exactly the reported case: src is the opaque `asset:` ref (bytes live in
    // IndexedDB); tldraw resolves it to a fetchable URL (here a data: URL stands
    // in for the blob: URL createObjectURL would return).
    canvasBridge.setEditor(
      makeVideoEditor({ assetPath: null, assetSrc: 'asset:v1', resolvedUrl: 'data:video/mp4;base64,WERG' }),
    )
    const res = (await canvasBridge.handle('get_canvas_video', { threadId: 't1' })) as {
      ok: boolean
      videoPath: string | null
      materialized: boolean
    }
    expect(res.ok).toBe(true)
    expect(res.videoPath).toBe('C:/agent/uploads/canvas-video-2.mp4')
    expect(res.materialized).toBe(true)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1', mime: 'video/mp4', base64: 'WERG' }))
  })

  it('prefers the recorded on-disk assetPath (no materialize needed)', async () => {
    canvasBridge.setEditor(makeVideoEditor({ assetPath: 'D:/clips/cat.mp4' }))
    const res = (await canvasBridge.handle('get_canvas_video', { threadId: 't1' })) as {
      ok: boolean
      videoPath: string | null
      materialized: boolean
      shapeId: string
    }
    expect(res.ok).toBe(true)
    expect(res.videoPath).toBe('D:/clips/cat.mp4')
    expect(res.materialized).toBe(false)
    expect(res.shapeId).toBe('shape:v1')
  })

  it('materializes the asset bytes to disk when the shape has no recorded path', async () => {
    const save = vi.fn(async () => ({ ok: true as const, path: 'C:/agent/uploads/canvas-video-1.mp4' }))
    ;(window as { electronAPI?: unknown }).electronAPI = { attachments: { save } }
    // No assetPath, no resolveAssetUrl on this editor build; the asset carries a
    // decodable data: src directly (fallback path).
    canvasBridge.setEditor(makeVideoEditor({ assetPath: null, assetSrc: 'data:video/mp4;base64,QUJD', resolvedUrl: undefined }))

    const res = (await canvasBridge.handle('get_canvas_video', { threadId: 't1' })) as {
      ok: boolean
      videoPath: string | null
      materialized: boolean
    }
    expect(res.ok).toBe(true)
    expect(res.videoPath).toBe('C:/agent/uploads/canvas-video-1.mp4')
    expect(res.materialized).toBe(true)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't1', mime: 'video/mp4', base64: 'QUJD' }),
    )
  })

  it('errors cleanly when there is no video on the canvas', async () => {
    canvasBridge.setEditor({
      store: {},
      getCurrentPageShapes: () => [],
      getCurrentPageShapeIds: () => new Set(),
      getSelectedShapeIds: () => [],
      getShapePageBounds: () => undefined,
    } as never)
    const res = (await canvasBridge.handle('get_canvas_video', {})) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('视频')
  })
})
