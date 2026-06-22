import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Box } from 'tldraw'
import { createImageVersion, zoomToFitShapes } from '../shapeOps'

/** jsdom never fires <img> load; resolve onload synchronously with fixed dims. */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 100
  naturalHeight = 200
  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

describe('C1: createImageVersion binds the version arrow to both images', () => {
  beforeEach(() => vi.stubGlobal('Image', FakeImage))
  afterEach(() => vi.unstubAllGlobals())

  it('creates two arrow bindings (start→source, end→new) referencing the same arrow', async () => {
    const bindings: any[] = []
    let arrowId: string | undefined
    const editor: any = {
      getShape: () => ({ id: 'shape:src', meta: { version: 1 }, props: { w: 100, h: 100 } }),
      getShapePageBounds: () => ({ x: 0, y: 0, w: 100, h: 100 }),
      createAssets: () => {},
      createShape: (shape: { id: string; type: string }) => {
        if (shape.type === 'arrow') arrowId = shape.id
      },
      createBindings: (b: any[]) => bindings.push(...b),
      select: () => {},
      run: (fn: () => void) => fn(),
    }
    const res = await createImageVersion(editor, { sourceShapeId: 'shape:src', assetUrl: 'data:image/png;base64,QUJD' })

    expect(bindings).toHaveLength(2)
    const start = bindings.find((b) => b.props.terminal === 'start')
    const end = bindings.find((b) => b.props.terminal === 'end')
    expect(start.type).toBe('arrow')
    expect(start.fromId).toBe(arrowId)
    expect(start.toId).toBe('shape:src')
    expect(end.fromId).toBe(arrowId)
    expect(end.toId).toBe(res.newShapeId)
    // No legacy point-binding shortcuts — both terminals are bound to shapes.
    expect(start.props.normalizedAnchor).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('C2: zoomToFitShapes frames off-screen shapes without ever zooming in', () => {
  function cameraEditor(opts: { viewport: Box; zoom: number; bounds: Record<string, Box> }) {
    const cam: any[] = []
    const editor: any = {
      getShapePageBounds: (id: string) => opts.bounds[id],
      getViewportPageBounds: () => opts.viewport,
      getViewportScreenBounds: () => new Box(0, 0, 800, 600),
      getZoomLevel: () => opts.zoom,
      setCamera: (point: any) => cam.push(point),
    }
    return { editor, cam }
  }

  it('pans to an off-screen shape (setCamera called, zoom never exceeds current)', () => {
    const { editor, cam } = cameraEditor({
      viewport: new Box(0, 0, 800, 600),
      zoom: 1,
      bounds: { 'shape:far': new Box(5000, 5000, 100, 100) },
    })
    zoomToFitShapes(editor, ['shape:far'])
    expect(cam).toHaveLength(1)
    expect(cam[0].z).toBeLessThanOrEqual(1)
    expect(cam[0].z).toBeGreaterThan(0)
  })

  it('does nothing when the shape is already in view', () => {
    const { editor, cam } = cameraEditor({
      viewport: new Box(0, 0, 800, 600),
      zoom: 1,
      bounds: { 'shape:near': new Box(10, 10, 50, 50) },
    })
    zoomToFitShapes(editor, ['shape:near'])
    expect(cam).toHaveLength(0)
  })

  it('is a safe no-op when the editor lacks camera APIs (non-tldraw fake)', () => {
    expect(() => zoomToFitShapes({ getShapePageBounds: () => undefined } as any, ['x'])).not.toThrow()
  })
})
