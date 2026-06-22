import { describe, expect, it } from 'vitest'
import { listImageShapes, summarizeShape } from '../shapeOps'

/**
 * Minimal fake editor: getShapePageBounds returns undefined so getBounds() falls
 * back to the shape's own x/y/props.w/h, and getAsset resolves the backing asset.
 */
function fakeEditor(shapes: unknown[], assets: Record<string, unknown> = {}): any {
  return {
    getCurrentPageShapes: () => shapes,
    getShapePageBounds: () => undefined,
    getSelectedShapeIds: () => [],
    getAsset: (id: string) => assets[id],
  }
}

const imageShape = {
  id: 'shape:img',
  type: 'image',
  x: 0,
  y: 0,
  props: { assetId: 'asset:1', w: 100, h: 200 },
  meta: {},
}

const assets = {
  'asset:1': { props: { src: 'asset:1', w: 1024, h: 2048 }, meta: { assetPath: 'C:/a.png' } },
}

describe('A: summarizeShape enriches image shapes from their backing asset (focused snapshot)', () => {
  it('resolves assetId, intrinsic dimensions, src and on-disk path (the "got meta:{}"痛点)', () => {
    const summary = summarizeShape(fakeEditor([imageShape], assets), imageShape)
    expect(summary.assetId).toBe('asset:1')
    expect(summary.imageWidth).toBe(1024)
    expect(summary.imageHeight).toBe(2048)
    expect(summary.assetUrl).toBe('asset:1')
    // shape.meta is empty, so the path must be recovered from the asset's meta.
    expect(summary.assetPath).toBe('C:/a.png')
  })

  it('does not require getAsset to exist (older fakes / no asset linked)', () => {
    const editorNoAsset = { getShapePageBounds: () => undefined } as any
    const summary = summarizeShape(editorNoAsset, { ...imageShape, props: { w: 10, h: 10 } })
    expect(summary.type).toBe('image')
    expect(summary.assetId).toBeUndefined()
  })
})

describe('list_canvas_images (borrowed from sora-canvas-mcp): flat image index', () => {
  it('returns only image shapes with shapeId/dims/assetId/path/hasFile', () => {
    const shapes = [
      imageShape,
      { id: 'shape:holder', type: 'geo', x: 0, y: 0, props: { w: 400, h: 560 }, meta: { aiCanvasRole: 'image_holder' } },
      { id: 'shape:arrow', type: 'arrow', x: 0, y: 0, props: {}, meta: {} },
    ]
    const { items } = listImageShapes(fakeEditor(shapes, assets))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      shapeId: 'shape:img',
      assetId: 'asset:1',
      w: 100,
      h: 200,
      assetPath: 'C:/a.png',
      hasFile: true,
    })
  })

  it('marks hasFile=false and nulls when no on-disk path is known', () => {
    const pasted = { id: 'shape:p', type: 'image', x: 0, y: 0, props: { assetId: 'asset:x', w: 50, h: 50 }, meta: {} }
    const { items } = listImageShapes(fakeEditor([pasted], {}))
    expect(items[0].hasFile).toBe(false)
    expect(items[0].assetPath).toBeNull()
    expect(items[0].assetId).toBe('asset:x')
  })
})
