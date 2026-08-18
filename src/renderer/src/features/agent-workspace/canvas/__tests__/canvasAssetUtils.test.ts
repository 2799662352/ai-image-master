import { describe, expect, it } from 'vitest'
import {
  Box,
  Editor,
  createTLStore,
  defaultAddFontsFromNode,
  defaultBindingUtils,
  defaultShapeUtils,
  defaultTools,
  tipTapDefaultExtensions,
} from 'tldraw'
import { canvasAssetUtils } from '../canvasAssetUtils'
import { canvasShapeUtils } from '../FileCardShapeUtil'
import { insertImageAt, insertVideo } from '../shapeOps'

// REAL-tldraw regression guard for the asset `src` protocol.
//
// tldraw's built-in `T.srcUrl` only accepts http/https/data/asset. Our asset
// store deliberately writes `local-file://` (and `blob:` for clipboard files)
// so bytes never enter IndexedDB — which means every image/video insert threw
// "Expected a valid url" at `store.put` and took the canvas React tree with it.
// A fake editor can't see this (no schema), so these tests use a real Editor.

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!(globalThis as Record<string, unknown>).ResizeObserver) {
  ;(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver
}
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as never
}

const shapeUtils = [...defaultShapeUtils, ...canvasShapeUtils]

function makeEditor(opts: { withCanvasAssetUtils: boolean }): Editor {
  const editor = new Editor({
    shapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: defaultTools,
    store: createTLStore({
      shapeUtils,
      bindingUtils: defaultBindingUtils,
      ...(opts.withCanvasAssetUtils ? { assetUtils: canvasAssetUtils } : undefined),
    }),
    getContainer: () => document.body,
    textOptions: { tipTapConfig: { extensions: tipTapDefaultExtensions }, addFontsFromNode: defaultAddFontsFromNode },
  })
  editor.updateViewportScreenBounds(new Box(0, 0, 1280, 800))
  return editor
}

const IMAGE_URL = 'local-file:///C%3A/Users/me/Downloads/image_1783320656940.png'
const VIDEO_URL = 'local-file://media/?p=C%3A%5Cclips%5Cshot.mp4'

function assetSrcs(editor: Editor): string[] {
  return editor.getAssets().map((a) => String((a as { props: { src?: unknown } }).props.src ?? ''))
}

describe('canvas asset utils: local-file / blob srcs survive real schema validation', () => {
  it('stock tldraw asset utils REJECT a local-file image src (the bug being fixed)', async () => {
    const editor = makeEditor({ withCanvasAssetUtils: false })
    try {
      await expect(insertImageAt(editor, { assetUrl: IMAGE_URL, assetPath: 'C:/Users/me/Downloads/x.png', w: 800, h: 600 })).rejects.toThrow(
        /valid url/i,
      )
    } finally {
      editor.dispose()
    }
  })

  it('insert_image_at commits a local-file src and keeps the shape linked to the asset', async () => {
    const editor = makeEditor({ withCanvasAssetUtils: true })
    try {
      const res = await insertImageAt(editor, {
        assetUrl: IMAGE_URL,
        assetPath: 'C:\\Users\\me\\Downloads\\image_1783320656940.png',
        w: 800,
        h: 600,
      })
      expect(assetSrcs(editor)).toContain(IMAGE_URL)
      const shape = editor.getShape(res.imageShapeId as never) as { props: { assetId: string } }
      expect(editor.getAsset(shape.props.assetId as never)).toBeTruthy()
    } finally {
      editor.dispose()
    }
  })

  it('insert_video commits a local-file://media streaming src', async () => {
    const editor = makeEditor({ withCanvasAssetUtils: true })
    try {
      await insertVideo(editor, { assetUrl: VIDEO_URL, assetPath: 'C:\\clips\\shot.mp4', w: 1280, h: 720 })
      expect(assetSrcs(editor)).toContain(VIDEO_URL)
    } finally {
      editor.dispose()
    }
  })

  it('a blob: src (clipboard file with no disk path) is accepted too', async () => {
    const editor = makeEditor({ withCanvasAssetUtils: true })
    const blobUrl = 'blob:http://localhost/2b0f1c8e-0000-4000-8000-000000000000'
    try {
      await insertImageAt(editor, { assetUrl: blobUrl, w: 400, h: 400 })
      expect(assetSrcs(editor)).toContain(blobUrl)
    } finally {
      editor.dispose()
    }
  })

  it('still rejects protocols tldraw considers unsafe (the allowlist stays an allowlist)', async () => {
    const editor = makeEditor({ withCanvasAssetUtils: true })
    try {
      await expect(insertImageAt(editor, { assetUrl: 'javascript:alert(1)', w: 10, h: 10 })).rejects.toThrow(/valid url/i)
      await expect(insertImageAt(editor, { assetUrl: 'file:///C:/secrets.png', w: 10, h: 10 })).rejects.toThrow(/valid url/i)
      // …and the editor is still usable after a rejected write.
      await insertImageAt(editor, { assetUrl: IMAGE_URL, w: 10, h: 10 })
      expect(assetSrcs(editor)).toContain(IMAGE_URL)
    } finally {
      editor.dispose()
    }
  })

  it('http/https/data srcs keep working (no regression for R2-hosted or tiny inline assets)', async () => {
    const editor = makeEditor({ withCanvasAssetUtils: true })
    try {
      await insertImageAt(editor, { assetUrl: 'https://cdn.example.com/a.png', w: 10, h: 10 })
      await insertImageAt(editor, { assetUrl: 'data:image/png;base64,QUJD', w: 10, h: 10 })
      const srcs = assetSrcs(editor)
      expect(srcs).toContain('https://cdn.example.com/a.png')
      expect(srcs).toContain('data:image/png;base64,QUJD')
    } finally {
      editor.dispose()
    }
  })
})
