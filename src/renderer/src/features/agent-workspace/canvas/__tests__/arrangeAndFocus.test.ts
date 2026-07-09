import { afterEach, describe, expect, it } from 'vitest'
import { arrangeShapes, focusRegion } from '../shapeOps'
import { canvasBridge } from '../canvasBridge'

// canvas_arrange (batch align/distribute/stack/pack) + canvas_focus_region
// (viewport navigation) — the action half of the tiered canvas_snapshot loop.

function makeEditor(shapeIds: string[] = ['shape:a', 'shape:b', 'shape:c']) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
  }
  let depth = 0
  const editor = {
    getShape: (id: string) => (shapeIds.includes(id) ? { id, type: 'geo' } : undefined),
    getCurrentPageShapes: () => shapeIds.map((id) => ({ id, type: 'geo' })),
    getShapePageBounds: (id: string) => {
      const i = shapeIds.indexOf(id)
      return i === -1 ? undefined : { x: i * 100, y: i * 50, w: 80, h: 40 }
    },
    getViewportPageBounds: () => ({ x: -10, y: -20, w: 800, h: 600 }),
    zoomToBounds: record('zoomToBounds'),
    alignShapes: record('alignShapes'),
    distributeShapes: record('distributeShapes'),
    stackShapes: record('stackShapes'),
    packShapes: record('packShapes'),
    run: (fn: () => void) => {
      depth += 1
      try {
        fn()
      } finally {
        depth -= 1
      }
    },
    // arrangeShapes must run the layout INSIDE editor.run — expose depth for asserts.
    _depthAt: () => depth,
  } as any
  return { editor, calls }
}

describe('arrangeShapes', () => {
  it('routes each operation to the matching tldraw batch API', () => {
    const cases: Array<[string, string, unknown[]]> = [
      ['align-left', 'alignShapes', ['left']],
      ['align-center-vertical', 'alignShapes', ['center-vertical']],
      ['distribute-horizontal', 'distributeShapes', ['horizontal']],
      ['stack-vertical', 'stackShapes', ['vertical', 24]],
      ['pack', 'packShapes', [16]],
    ]
    for (const [operation, method, tailArgs] of cases) {
      const { editor, calls } = makeEditor()
      const res = arrangeShapes(editor, ['shape:a', 'shape:b', 'shape:c'], operation as never, operation === 'stack-vertical' ? 24 : undefined)
      expect(res).toMatchObject({ ok: true, operation, arrangedCount: 3 })
      const call = calls.find((c) => c.method === method)
      expect(call, `${operation} should call ${method}`).toBeTruthy()
      expect(call!.args.slice(1)).toEqual(tailArgs)
    }
  })

  it('rejects too-few shapes with a friendly error (align <2, distribute <3)', () => {
    const { editor } = makeEditor()
    expect(arrangeShapes(editor, ['shape:a'], 'align-left')).toMatchObject({ ok: false })
    expect(arrangeShapes(editor, ['shape:a', 'shape:b'], 'distribute-vertical')).toMatchObject({ ok: false })
    // ≥3 distribute passes
    expect(arrangeShapes(editor, ['shape:a', 'shape:b', 'shape:c'], 'distribute-vertical')).toMatchObject({ ok: true })
  })
})

describe('focusRegion', () => {
  it('zooms to explicit page bounds and reports the new viewport', () => {
    const { editor, calls } = makeEditor()
    const res = focusRegion(editor, { bounds: { x: 500, y: 300, w: 400, h: 200 } })
    expect(res).toMatchObject({ ok: true, viewportBounds: { x: -10, y: -20, w: 800, h: 600 } })
    const zoom = calls.find((c) => c.method === 'zoomToBounds')
    expect(zoom!.args[0]).toMatchObject({ x: 500, y: 300, w: 400, h: 200 })
  })

  it('zooms to the UNION of the given shapes bounds', () => {
    const { editor, calls } = makeEditor()
    const res = focusRegion(editor, { shapeIds: ['shape:a', 'shape:c'] })
    expect(res.ok).toBe(true)
    // a at (0,0,80,40), c at (200,100,80,40) → union (0,0,280,140)
    expect(calls.find((c) => c.method === 'zoomToBounds')!.args[0]).toMatchObject({ x: 0, y: 0, w: 280, h: 140 })
  })

  it('fails with a structured error when neither bounds nor resolvable shapes are given', () => {
    const { editor } = makeEditor()
    expect(focusRegion(editor, {})).toMatchObject({ ok: false })
    expect(focusRegion(editor, { shapeIds: ['shape:nope'] })).toMatchObject({ ok: false })
  })
})

describe('canvasBridge canvas_arrange / canvas_focus_region dispatch', () => {
  afterEach(() => canvasBridge.setEditor(null))

  it('canvas_arrange self-heals prefix-less shape ids before arranging', async () => {
    const { editor, calls } = makeEditor(['shape:img1', 'shape:img2'])
    canvasBridge.setEditor(editor)
    const res: any = await canvasBridge.handle('canvas_arrange', { shapeIds: ['img1', 'img2'], operation: 'align-top' })
    expect(res).toMatchObject({ ok: true, operation: 'align-top', arrangedCount: 2 })
    expect(calls.find((c) => c.method === 'alignShapes')!.args[0]).toEqual(['shape:img1', 'shape:img2'])
  })

  it('canvas_arrange rejects an unknown operation with the valid list', async () => {
    const { editor } = makeEditor()
    canvasBridge.setEditor(editor)
    const res: any = await canvasBridge.handle('canvas_arrange', { shapeIds: ['shape:a', 'shape:b'], operation: 'sideways' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('align-left')
  })

  it('canvas_arrange surfaces resolveShapeId candidates for a hopeless id', async () => {
    const { editor } = makeEditor(['shape:a', 'shape:b'])
    canvasBridge.setEditor(editor)
    const res: any = await canvasBridge.handle('canvas_arrange', { shapeIds: ['shape:zzz_does_not_exist', 'shape:b'], operation: 'align-left' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('shape:a')
  })

  it('canvas_focus_region returns viewportBounds plus a re-snapshot hint', async () => {
    const { editor } = makeEditor()
    canvasBridge.setEditor(editor)
    const res: any = await canvasBridge.handle('canvas_focus_region', { bounds: { x: 0, y: 0, w: 100, h: 100 } })
    expect(res.ok).toBe(true)
    expect(res.viewportBounds).toEqual({ x: -10, y: -20, w: 800, h: 600 })
    expect(String(res.hint)).toContain('canvas_snapshot')
  })
})
