import { afterEach, describe, expect, it } from 'vitest'
import type { ShapeSummary } from '../../../../../types/canvas'
import {
  buildTieredShapes,
  computePlacement,
  deleteShapesById,
  diffShapeFingerprints,
  fingerprintSummaries,
  sanitizeSummaryForAgent,
  truncateDataUrl,
  updateShapePartial,
} from '../shapeOps'
import { canvasBridge } from '../canvasBridge'

// P0 snapshot payload hygiene + P1 structured update/delete + P2 snapshot diff
// (aligning with the official tldraw Agent Starter Kit: never send raw asset
// payloads to the model; ship dedicated update/delete actions; tell the agent
// what the user changed between its looks at the canvas).

const BIG_DATA_URL = `data:image/png;base64,${'A'.repeat(500_000)}`

function summary(partial: Partial<ShapeSummary> & { id: string }): ShapeSummary {
  return {
    type: 'geo',
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    ...partial,
  } as ShapeSummary
}

describe('truncateDataUrl / sanitizeSummaryForAgent (P0)', () => {
  it('replaces a multi-MB data: URL with a short descriptor carrying the mime + size', () => {
    const out = truncateDataUrl(BIG_DATA_URL)
    expect(out.length).toBeLessThan(200)
    expect(out).toContain('image/png')
    expect(out).toContain('KB omitted')
    expect(out).toContain('assetPath')
  })

  it('leaves short data: URLs, http(s), blob: and plain strings alone', () => {
    expect(truncateDataUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
    expect(truncateDataUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(truncateDataUrl('C:/images/a.png')).toBe('C:/images/a.png')
  })

  it('sanitizes assetUrl AND meta.assetUrl, and rounds bounds/arrow points', () => {
    const s = summary({
      id: 'shape:a',
      bounds: { x: 10.6, y: 20.4, w: 99.9, h: 50.2 },
      assetUrl: BIG_DATA_URL,
      arrowStart: { x: 1.7, y: 2.2 },
      arrowEnd: { x: 9.5, y: 8.1 },
      meta: { assetUrl: BIG_DATA_URL, title: '猫猫', assetPath: 'C:/a.png' } as never,
    })
    const clean = sanitizeSummaryForAgent(s)
    expect(clean.bounds).toEqual({ x: 11, y: 20, w: 100, h: 50 })
    expect(clean.arrowStart).toEqual({ x: 2, y: 2 })
    expect(clean.arrowEnd).toEqual({ x: 10, y: 8 })
    expect(clean.assetUrl!.length).toBeLessThan(200)
    expect((clean.meta as Record<string, unknown>).assetUrl as string).toContain('omitted')
    // Useful meta keys survive untouched.
    expect((clean.meta as Record<string, unknown>).title).toBe('猫猫')
    expect((clean.meta as Record<string, unknown>).assetPath).toBe('C:/a.png')
    // The original summary is NOT mutated (internal consumers need the real URL).
    expect(s.assetUrl).toBe(BIG_DATA_URL)
    expect((s.meta as Record<string, unknown>).assetUrl).toBe(BIG_DATA_URL)
  })

  it('buildTieredShapes full mode sanitizes every summary (the old leak path)', () => {
    const shapes = [summary({ id: 'shape:leak', type: 'image', assetUrl: BIG_DATA_URL, meta: { assetUrl: BIG_DATA_URL } as never })]
    const result = buildTieredShapes({ getViewportPageBounds: () => ({ x: 0, y: 0, w: 1000, h: 1000 }) } as never, shapes)
    expect(result.detailLevel).toBe('full')
    const out = result.shapes[0] as ShapeSummary
    expect(out.assetUrl!.length).toBeLessThan(200)
    expect(((out.meta as Record<string, unknown>).assetUrl as string).length).toBeLessThan(200)
  })

  it('buildTieredShapes sanitizes focusedShapes in tiered mode too', () => {
    const many = Array.from({ length: 60 }, (_, i) => summary({ id: `shape:${i}`, bounds: { x: i * 20, y: 0, w: 10, h: 10 } }))
    many[0] = summary({ id: 'shape:0', assetUrl: BIG_DATA_URL, bounds: { x: 0, y: 0, w: 10, h: 10 } })
    const result = buildTieredShapes(
      { getViewportPageBounds: () => ({ x: 0, y: 0, w: 500, h: 500 }) } as never,
      many,
      { focusShapeIds: ['shape:0'] },
    )
    expect(result.detailLevel).toBe('tiered')
    const focused = result.focusedShapes!.find((s) => s.id === 'shape:0')!
    expect(focused.assetUrl!.length).toBeLessThan(200)
  })
})

type Call = { method: string; args: unknown[] }

/** Fake editor with real-ish shapes for update/delete + bridge dispatch tests. */
function makeEditor() {
  const calls: Call[] = []
  const shapes = new Map<string, { id: string; type: string; x: number; y: number; props: Record<string, unknown>; meta?: Record<string, unknown> }>([
    ['shape:note1', { id: 'shape:note1', type: 'geo', x: 10, y: 20, props: { w: 100, h: 80, color: 'black', richText: { type: 'doc', content: [] } } }],
    ['shape:img1', { id: 'shape:img1', type: 'image', x: 200, y: 20, props: { w: 300, h: 200 } }],
  ])
  const editor = {
    getShape: (id: string) => shapes.get(id),
    getCurrentPageShapes: () => Array.from(shapes.values()),
    getShapePageBounds: (id: string) => {
      const s = shapes.get(id)
      return s ? { x: s.x, y: s.y, w: Number(s.props.w ?? 100), h: Number(s.props.h ?? 100) } : undefined
    },
    updateShape: (update: { id: string; x?: number; y?: number; rotation?: number; props?: Record<string, unknown> }) => {
      calls.push({ method: 'updateShape', args: [update] })
      const s = shapes.get(update.id)!
      if (typeof update.x === 'number') s.x = update.x
      if (typeof update.y === 'number') s.y = update.y
      if (update.props) Object.assign(s.props, update.props)
    },
    deleteShapes: (ids: string[]) => {
      calls.push({ method: 'deleteShapes', args: [ids] })
      for (const id of ids) shapes.delete(id)
    },
    run: (fn: () => void) => fn(),
  } as never
  return { editor, calls, shapes }
}

describe('updateShapePartial (P1)', () => {
  it('applies x/y/w/h/color and converts rotation degrees to radians', () => {
    const { editor, calls } = makeEditor()
    const res = updateShapePartial(editor, 'shape:note1', { x: 50, y: 60, w: 120.4, h: 90, rotation: 90, color: 'red' })
    expect(res.ok).toBe(true)
    const update = calls.find((c) => c.method === 'updateShape')!.args[0] as Record<string, unknown>
    expect(update.x).toBe(50)
    expect(update.rotation).toBeCloseTo(Math.PI / 2)
    expect((update.props as Record<string, unknown>).w).toBe(120.4)
    expect((update.props as Record<string, unknown>).color).toBe('red')
    if (res.ok) expect(res.shape.bounds.x).toBe(50)
  })

  it('writes text via richText for shapes that have a richText prop', () => {
    const { editor, calls } = makeEditor()
    const res = updateShapePartial(editor, 'shape:note1', { text: '新标签' })
    expect(res.ok).toBe(true)
    const props = (calls.find((c) => c.method === 'updateShape')!.args[0] as { props: Record<string, unknown> }).props
    expect(props.richText).toBeTruthy()
    expect(JSON.stringify(props.richText)).toContain('新标签')
  })

  it('rejects resize on shapes without w/h props and rejects empty patches', () => {
    const { editor, shapes } = makeEditor()
    shapes.set('shape:draw', { id: 'shape:draw', type: 'draw', x: 0, y: 0, props: {} })
    expect(updateShapePartial(editor, 'shape:draw', { w: 100 })).toMatchObject({ ok: false })
    expect(updateShapePartial(editor, 'shape:note1', {})).toMatchObject({ ok: false })
    expect(updateShapePartial(editor, 'shape:gone', { x: 1 })).toMatchObject({ ok: false })
  })
})

describe('deleteShapesById (P1)', () => {
  it('deletes the given shapes in one transaction and reports the ids', () => {
    const { editor, shapes } = makeEditor()
    const res = deleteShapesById(editor, ['shape:note1'])
    expect(res).toMatchObject({ ok: true, deletedCount: 1, deletedIds: ['shape:note1'] })
    expect(shapes.has('shape:note1')).toBe(false)
    expect(shapes.has('shape:img1')).toBe(true)
  })

  it('rejects an empty id list', () => {
    const { editor } = makeEditor()
    expect(deleteShapesById(editor, [])).toMatchObject({ ok: false })
  })
})

describe('canvasBridge canvas_update_shape / canvas_delete_shapes dispatch', () => {
  afterEach(() => canvasBridge.setEditor(null))

  it('canvas_update_shape self-heals a prefix-less id and returns the updated summary', async () => {
    const { editor } = makeEditor()
    canvasBridge.setEditor(editor)
    const res: any = await canvasBridge.handle('canvas_update_shape', { shapeId: 'note1', x: 500 })
    expect(res.ok).toBe(true)
    expect(res.shape.id).toBe('shape:note1')
    expect(res.shape.bounds.x).toBe(500)
  })

  it('canvas_update_shape surfaces a structured error for a hopeless id', async () => {
    const { editor } = makeEditor()
    canvasBridge.setEditor(editor)
    const res: any = await canvasBridge.handle('canvas_update_shape', { shapeId: 'shape:zzz_nope', x: 1 })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('shape:')
  })

  it('canvas_delete_shapes resolves ids, deletes, and rejects an empty list', async () => {
    const { editor, shapes } = makeEditor()
    canvasBridge.setEditor(editor)
    const res: any = await canvasBridge.handle('canvas_delete_shapes', { shapeIds: ['img1'] })
    expect(res).toMatchObject({ ok: true, deletedCount: 1 })
    expect(shapes.has('shape:img1')).toBe(false)
    const empty: any = await canvasBridge.handle('canvas_delete_shapes', { shapeIds: [] })
    expect(empty.ok).toBe(false)
  })
})

describe('diffShapeFingerprints (P2)', () => {
  it('reports created / updated / deleted shape ids between two snapshots', () => {
    const before = fingerprintSummaries([
      summary({ id: 'shape:kept', bounds: { x: 0, y: 0, w: 10, h: 10 } }),
      summary({ id: 'shape:moved', bounds: { x: 0, y: 0, w: 10, h: 10 } }),
      summary({ id: 'shape:gone', bounds: { x: 5, y: 5, w: 10, h: 10 } }),
    ])
    const after = [
      summary({ id: 'shape:kept', bounds: { x: 0, y: 0, w: 10, h: 10 } }),
      summary({ id: 'shape:moved', bounds: { x: 400, y: 0, w: 10, h: 10 } }),
      summary({ id: 'shape:new', bounds: { x: 9, y: 9, w: 10, h: 10 } }),
    ]
    const diff = diffShapeFingerprints(before, after)!
    expect(diff.created).toEqual(['shape:new'])
    expect(diff.updated).toEqual(['shape:moved'])
    expect(diff.deleted).toEqual(['shape:gone'])
  })

  it('returns undefined when nothing changed (field omitted from the snapshot)', () => {
    const shapes = [summary({ id: 'shape:a' }), summary({ id: 'shape:b', text: 'hi' })]
    expect(diffShapeFingerprints(fingerprintSummaries(shapes), shapes)).toBeUndefined()
  })

  it('counts a text edit as an update', () => {
    const before = fingerprintSummaries([summary({ id: 'shape:t', text: 'old' })])
    const diff = diffShapeFingerprints(before, [summary({ id: 'shape:t', text: 'new' })])!
    expect(diff.updated).toEqual(['shape:t'])
  })
})

describe('computePlacement (official Place action math)', () => {
  const ref = { x: 100, y: 100, w: 200, h: 100 } // reference bounds
  const target = { w: 50, h: 20 }

  it('bottom/center with a gap — the caption-under-image case', () => {
    expect(computePlacement(target, ref, 'bottom', 'center', 16)).toEqual({ x: 175, y: 216 })
  })

  it('top/start — shot number pinned to the top-left corner', () => {
    expect(computePlacement(target, ref, 'top', 'start', 8, 4)).toEqual({ x: 104, y: 72 })
  })

  it('right/end and left/center', () => {
    expect(computePlacement(target, ref, 'right', 'end', 10, 6)).toEqual({ x: 310, y: 174 })
    expect(computePlacement(target, ref, 'left', 'center')).toEqual({ x: 50, y: 140 })
  })

  it('defaults: align center, zero offsets', () => {
    expect(computePlacement(target, ref, 'bottom')).toEqual({ x: 175, y: 200 })
  })
})
