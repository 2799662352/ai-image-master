import { describe, expect, it, vi } from 'vitest'
import { GeoShapeGeoStyle } from 'tldraw'
import {
  applySketchShape,
  exportSketch,
  sketchFileName,
  SHAPE_TOOLS,
  SKETCH_COLORS,
  SKETCH_SHAPES,
  STROKE_STOPS,
} from '../sketch/sketchExport'

/**
 * Sketch pad (design D3) export: the tldraw editor's current page → PNG blob.
 * Exercised against a fake editor because the real one needs a DOM canvas.
 */
function fakeEditor(shapeIds: string[]) {
  return {
    getCurrentPageShapeIds: vi.fn(() => new Set(shapeIds)),
    toImage: vi.fn(async () => ({ blob: new Blob([new Uint8Array([9])], { type: 'image/png' }), width: 10, height: 10 })),
  }
}

describe('exportSketch', () => {
  it('returns null (nothing to attach) for an empty page and never renders', async () => {
    const editor = fakeEditor([])
    await expect(exportSketch(editor as never)).resolves.toBeNull()
    expect(editor.toImage).not.toHaveBeenCalled()
  })

  it('renders all shapes on the page to a PNG with a white background', async () => {
    const editor = fakeEditor(['shape:a', 'shape:b'])
    const blob = await exportSketch(editor as never)
    expect(blob?.type).toBe('image/png')
    expect(editor.toImage).toHaveBeenCalledTimes(1)
    const [ids, opts] = editor.toImage.mock.calls[0] as unknown as [string[], Record<string, unknown>]
    expect([...ids].sort()).toEqual(['shape:a', 'shape:b'])
    expect(opts).toMatchObject({ format: 'png', background: true })
  })
})

describe('sketchFileName', () => {
  it('is a timestamped 草图-*.png name', () => {
    expect(sketchFileName(new Date('2026-09-14T10:05:09Z'))).toMatch(/^草图-\d{8}-\d{6}\.png$/)
  })
})

describe('形状 flyout (user feedback: 形状工具应该可以选择)', () => {
  it('offers geo shapes plus arrow and line, each with a unique id', () => {
    const ids = SKETCH_SHAPES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(SKETCH_SHAPES.filter((s) => s.kind === 'geo').length).toBeGreaterThanOrEqual(5)
    expect(SKETCH_SHAPES.some((s) => s.kind === 'tool' && s.tool === 'arrow')).toBe(true)
    expect(SKETCH_SHAPES.some((s) => s.kind === 'tool' && s.tool === 'line')).toBe(true)
    // every geo choice is a value tldraw's own geo style accepts
    const geoValues = Array.from(GeoShapeGeoStyle.values as Iterable<string>)
    for (const s of SKETCH_SHAPES) if (s.kind === 'geo') expect(geoValues).toContain(s.geo)
  })

  it('applySketchShape: geo → sets tldraw:geo for next shapes and switches to the geo tool', () => {
    const editor = { setStyleForNextShapes: vi.fn(), setCurrentTool: vi.fn() }
    const ellipse = SKETCH_SHAPES.find((s) => s.id === 'ellipse')!
    expect(applySketchShape(editor, ellipse)).toBe('geo')
    expect(editor.setStyleForNextShapes).toHaveBeenCalledWith(GeoShapeGeoStyle, 'ellipse')
    expect(editor.setCurrentTool).toHaveBeenCalledWith('geo')
  })

  it('applySketchShape: arrow / line are their own tools and touch no style', () => {
    const editor = { setStyleForNextShapes: vi.fn(), setCurrentTool: vi.fn() }
    const arrow = SKETCH_SHAPES.find((s) => s.id === 'arrow')!
    expect(applySketchShape(editor, arrow)).toBe('arrow')
    expect(editor.setStyleForNextShapes).not.toHaveBeenCalled()
    expect(editor.setCurrentTool).toHaveBeenCalledWith('arrow')
    expect(SHAPE_TOOLS.has('arrow')).toBe(true)
    expect(SHAPE_TOOLS.has('draw')).toBe(false)
  })
})

describe('STROKE_STOPS', () => {
  it('goes thin → thick over the four tldraw size buckets', () => {
    expect(STROKE_STOPS.map((s) => s.id)).toEqual(['s', 'm', 'l', 'xl'])
    for (let i = 1; i < STROKE_STOPS.length; i++) expect(STROKE_STOPS[i].px).toBeGreaterThan(STROKE_STOPS[i - 1].px)
  })
})

describe('SKETCH_COLORS', () => {
  it('maps every palette dot to a valid tldraw colour style', () => {
    const valid = new Set(['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white'])
    expect(SKETCH_COLORS.length).toBeGreaterThanOrEqual(8)
    for (const c of SKETCH_COLORS) expect(valid.has(c.style)).toBe(true)
  })
})
