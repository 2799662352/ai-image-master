import { describe, expect, it } from 'vitest'
import type { ShapeSummary } from '../../../../../types/canvas'
import { buildCanvasLints, resolveShapeId } from '../shapeOps'

/**
 * C: shapeId sanitize self-heal (Agent Starter Kit's ensureShapeIdExists idea)
 * D: canvas lints attached to canvas_snapshot (attention hints for the agent)
 */

function editorWith(shapes: Array<{ id: string; type?: string }>): any {
  const byId = new Map(shapes.map((s) => [s.id, s]))
  return {
    getShape: (id: string) => byId.get(id),
    getCurrentPageShapes: () => shapes,
  }
}

describe('resolveShapeId (C: self-heal hallucinated ids)', () => {
  const shapes = [
    { id: 'shape:img_abc123', type: 'image' },
    { id: 'shape:holder_xyz', type: 'geo' },
    { id: 'shape:note_1', type: 'text' },
  ]

  it('passes an exact id through unchanged', () => {
    const r = resolveShapeId(editorWith(shapes), 'shape:img_abc123')
    expect(r).toEqual({ ok: true, id: 'shape:img_abc123', corrected: false })
  })

  it('heals a missing shape: prefix', () => {
    const r = resolveShapeId(editorWith(shapes), 'img_abc123')
    expect(r).toEqual({ ok: true, id: 'shape:img_abc123', corrected: true })
  })

  it('heals a unique case-insensitive match', () => {
    const r = resolveShapeId(editorWith(shapes), 'SHAPE:IMG_ABC123')
    expect(r).toEqual({ ok: true, id: 'shape:img_abc123', corrected: true })
  })

  it('fails a hopeless id with candidate list (one-step correction)', () => {
    const r = resolveShapeId(editorWith(shapes), 'shape:does_not_exist', { preferType: 'image' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('shape:img_abc123')
      expect(r.error).toContain('canvas_snapshot')
    }
  })

  it('rejects an empty id', () => {
    expect(resolveShapeId(editorWith(shapes), '  ').ok).toBe(false)
  })
})

function summary(partial: Partial<ShapeSummary> & { id: string }): ShapeSummary {
  return { type: 'geo', bounds: { x: 0, y: 0, w: 100, h: 100 }, ...partial } as ShapeSummary
}

describe('buildCanvasLints (D: attention hints in canvas_snapshot)', () => {
  it('flags images overlapping by more than 25% of the smaller one', () => {
    const lints = buildCanvasLints([
      summary({ id: 'shape:a', type: 'image', bounds: { x: 0, y: 0, w: 100, h: 100 } }),
      summary({ id: 'shape:b', type: 'image', bounds: { x: 50, y: 0, w: 100, h: 100 } }),
    ])
    expect(lints.some((l) => l.kind === 'overlapping-images' && l.shapeIds.includes('shape:a') && l.shapeIds.includes('shape:b'))).toBe(true)
  })

  it('does NOT flag lightly touching images', () => {
    const lints = buildCanvasLints([
      summary({ id: 'shape:a', type: 'image', bounds: { x: 0, y: 0, w: 100, h: 100 } }),
      summary({ id: 'shape:b', type: 'image', bounds: { x: 95, y: 0, w: 100, h: 100 } }),
    ])
    expect(lints.some((l) => l.kind === 'overlapping-images')).toBe(false)
  })

  it('flags a holder no inserted image references, but not a filled one', () => {
    const lints = buildCanvasLints([
      summary({ id: 'shape:h1', type: 'geo', role: 'image_holder', text: '主角立绘' }),
      summary({ id: 'shape:h2', type: 'geo', role: 'image_holder', bounds: { x: 500, y: 0, w: 100, h: 100 } }),
      summary({ id: 'shape:img', type: 'image', bounds: { x: 500, y: 0, w: 100, h: 100 }, meta: { holderId: 'shape:h2' } }),
    ])
    const empty = lints.filter((l) => l.kind === 'empty-holder')
    expect(empty).toHaveLength(1)
    expect(empty[0].shapeIds).toEqual(['shape:h1'])
  })

  it('flags degenerate media/geo shapes but not zero-height text fallbacks', () => {
    const lints = buildCanvasLints([
      summary({ id: 'shape:tiny', type: 'image', bounds: { x: 0, y: 0, w: 1, h: 1 } }),
      summary({ id: 'shape:note', type: 'text', bounds: { x: 0, y: 0, w: 360, h: 0 } }),
    ])
    expect(lints.some((l) => l.kind === 'degenerate-shape' && l.shapeIds[0] === 'shape:tiny')).toBe(true)
    expect(lints.some((l) => l.shapeIds[0] === 'shape:note')).toBe(false)
  })

  it('flags content stranded far from the origin and returns [] for a clean canvas', () => {
    expect(buildCanvasLints([summary({ id: 'shape:far', bounds: { x: 50000, y: 0, w: 10, h: 10 } })]).some((l) => l.kind === 'far-from-origin')).toBe(true)
    expect(buildCanvasLints([summary({ id: 'shape:ok' })])).toEqual([])
  })
})
