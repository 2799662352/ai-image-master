import { describe, expect, it } from 'vitest'
import type { ShapeSummary } from '../../../../../types/canvas'
import { buildTieredShapes, clusterPeripheralShapes, toBlurryShape, TIERED_SNAPSHOT_THRESHOLD } from '../shapeOps'

/**
 * Tiered canvas_snapshot (borrowed from tldraw's official Agent Starter Kit):
 * blurry viewport overview + focused selection + peripheral clusters, so a
 * large canvas can't blow up the model's context.
 */

function summary(partial: Partial<ShapeSummary> & { id: string }): ShapeSummary {
  return {
    type: 'geo',
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    ...partial,
  } as ShapeSummary
}

/** Fake editor whose viewport is the 0,0 → 1000,1000 page rect. */
function fakeEditor(viewport: { x: number; y: number; w: number; h: number } | null = { x: 0, y: 0, w: 1000, h: 1000 }): any {
  return viewport ? { getViewportPageBounds: () => viewport } : {}
}

describe('toBlurryShape', () => {
  it('rounds bounds, truncates text and drops the meta object', () => {
    const s = summary({
      id: 'shape:a',
      type: 'text',
      bounds: { x: 10.6, y: 20.4, w: 99.9, h: 50.2 },
      text: 'x'.repeat(200),
      meta: { aiCanvasRole: 'ai_image', title: 'big meta payload' },
      assetPath: 'C:/a.png',
    })
    const blurry = toBlurryShape(s)
    expect(blurry.bounds).toEqual({ x: 11, y: 20, w: 100, h: 50 })
    expect(blurry.text!.length).toBeLessThanOrEqual(81) // 80 + ellipsis
    expect(blurry.text!.endsWith('…')).toBe(true)
    expect((blurry as Record<string, unknown>).meta).toBeUndefined()
    // Addressing fields survive so the agent can drill down.
    expect(blurry.assetPath).toBe('C:/a.png')
    expect(blurry.id).toBe('shape:a')
  })

  it('keeps short text as-is and omits absent fields', () => {
    const blurry = toBlurryShape(summary({ id: 'shape:b', text: 'hello' }))
    expect(blurry.text).toBe('hello')
    expect(blurry.assetPath).toBeUndefined()
    expect(blurry.role).toBeUndefined()
  })
})

describe('clusterPeripheralShapes', () => {
  it('merges nearby shapes into one cluster with union bounds and a type histogram', () => {
    const clusters = clusterPeripheralShapes([
      summary({ id: '1', type: 'image', bounds: { x: 5000, y: 5000, w: 100, h: 100 } }),
      summary({ id: '2', type: 'image', bounds: { x: 5200, y: 5100, w: 100, h: 100 } }),
      summary({ id: '3', type: 'text', bounds: { x: 5100, y: 5300, w: 100, h: 40 } }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0].count).toBe(3)
    expect(clusters[0].types).toEqual({ image: 2, text: 1 })
    expect(clusters[0].bounds).toEqual({ x: 5000, y: 5000, w: 300, h: 340 })
  })

  it('keeps distant groups in separate clusters', () => {
    const clusters = clusterPeripheralShapes([
      summary({ id: '1', type: 'image', bounds: { x: 0, y: 0, w: 10, h: 10 } }),
      summary({ id: '2', type: 'image', bounds: { x: 50000, y: 50000, w: 10, h: 10 } }),
    ])
    expect(clusters).toHaveLength(2)
  })
})

describe('buildTieredShapes', () => {
  const manyShapes = (n: number, boundsFor: (i: number) => { x: number; y: number; w: number; h: number }): ShapeSummary[] =>
    Array.from({ length: n }, (_, i) => summary({ id: `shape:${i}`, bounds: boundsFor(i) }))

  it('returns full detail below the threshold (small canvas keeps old behavior)', () => {
    const shapes = manyShapes(5, () => ({ x: 0, y: 0, w: 10, h: 10 }))
    const result = buildTieredShapes(fakeEditor(), shapes)
    expect(result.detailLevel).toBe('full')
    // Sanitized copies (bounds rounded, data: URLs stubbed), same content here.
    expect(result.shapes).toEqual(shapes)
    expect(result.peripheralClusters).toBeUndefined()
  })

  it('returns full detail when full:true even above the threshold', () => {
    const shapes = manyShapes(TIERED_SNAPSHOT_THRESHOLD + 10, () => ({ x: 0, y: 0, w: 10, h: 10 }))
    const result = buildTieredShapes(fakeEditor(), shapes, { full: true })
    expect(result.detailLevel).toBe('full')
  })

  it('returns full detail when the editor cannot report a viewport (simple fakes)', () => {
    const shapes = manyShapes(TIERED_SNAPSHOT_THRESHOLD + 10, () => ({ x: 0, y: 0, w: 10, h: 10 }))
    const result = buildTieredShapes(fakeEditor(null), shapes)
    expect(result.detailLevel).toBe('full')
  })

  it('tiers a large canvas: blurry viewport shapes, focused selection, peripheral clusters', () => {
    // 30 in-viewport + 30 far off-viewport = 60 > threshold.
    const inView = manyShapes(30, (i) => ({ x: i * 20, y: 100, w: 10, h: 10 }))
    const offView = Array.from({ length: 30 }, (_, i) =>
      summary({ id: `shape:far${i}`, type: 'image', bounds: { x: 9000 + i * 20, y: 9000, w: 10, h: 10 } }),
    )
    const selectedId = 'shape:far0'
    const result = buildTieredShapes(fakeEditor(), [...inView, ...offView], {
      selectedIds: [selectedId],
      focusShapeIds: ['shape:5'],
    })
    expect(result.detailLevel).toBe('tiered')
    expect(result.viewportBounds).toEqual({ x: 0, y: 0, w: 1000, h: 1000 })
    // Selected + focus ids come back in FULL detail regardless of position.
    const focusedIds = result.focusedShapes!.map((s) => s.id)
    expect(focusedIds).toContain(selectedId)
    expect(focusedIds).toContain('shape:5')
    // Blurry tier = viewport shapes minus the focused one.
    expect(result.shapes).toHaveLength(29)
    expect((result.shapes[0] as Record<string, unknown>).meta).toBeUndefined()
    // Off-viewport shapes (minus the selected one) collapse into clusters.
    const clustered = result.peripheralClusters!.reduce((acc, c) => acc + c.count, 0)
    expect(clustered).toBe(29)
  })
})
