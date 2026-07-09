import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Box, Editor, createShapeId, createTLStore, defaultAddFontsFromNode, defaultBindingUtils, defaultShapeUtils, defaultTools, tipTapDefaultExtensions } from 'tldraw'
import { canvasBridge } from '../canvasBridge'
import { canvasShapeUtils } from '../FileCardShapeUtil'
import { TIERED_SNAPSHOT_THRESHOLD } from '../shapeOps'

// REAL-tldraw smoke test (headless `new Editor(...)`, the official
// write-unit-tests skill pattern): every other canvas suite uses hand-rolled
// fake editors, which can't catch what actually bit us in the past — tldraw's
// schema validation rejecting a write (bad prop name / bad meta) and crashing
// the canvas. This runs the NEW agent tool chain (tiered snapshot →
// focus_region → update/delete → arrange → diff) against a real 5.2 Editor so
// a tldraw upgrade or a prop mistake fails HERE, not in production.

// jsdom lacks the observers/media APIs the Editor constructor touches.
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

function makeRealEditor(): Editor {
  const editor = new Editor({
    shapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: defaultTools,
    store: createTLStore({ shapeUtils, bindingUtils: defaultBindingUtils }),
    getContainer: () => document.body,
    // The <Tldraw> component wires these by default; a raw headless Editor
    // throws "Cannot use text without setting textOptions" on richText writes.
    textOptions: { tipTapConfig: { extensions: tipTapDefaultExtensions }, addFontsFromNode: defaultAddFontsFromNode },
  })
  // jsdom reports a 0×0 container; give the editor a real screen so the
  // viewport (and therefore tiered snapshots) behaves like production.
  editor.updateViewportScreenBounds(new Box(0, 0, 1280, 800))
  return editor
}

let editor: Editor

beforeEach(() => {
  editor = makeRealEditor()
  canvasBridge.setEditor(editor)
})

afterEach(() => {
  canvasBridge.setEditor(null)
  editor.dispose()
})

function createGeo(id: string, x: number, y: number): void {
  editor.createShape({ id: createShapeId(id), type: 'geo', x, y, props: { w: 100, h: 80, geo: 'rectangle' } })
}

describe('real tldraw Editor smoke: new agent tool chain', () => {
  it('canvas_update_shape survives real schema validation (move/resize/rotate/color, then text)', async () => {
    createGeo('g1', 10, 10)
    const res: any = await canvasBridge.handle('canvas_update_shape', {
      shapeId: 'g1', // prefix-less on purpose: resolveShapeId must heal it
      x: 300,
      y: 200,
      w: 240,
      h: 120,
      rotation: 45,
      color: 'red',
    })
    if (!res.ok) throw new Error(`canvas_update_shape failed: ${res.error}`)
    const shape = editor.getShape(createShapeId('g1')) as any
    expect(shape.x).toBe(300)
    expect(shape.props.w).toBe(240)
    expect(shape.props.color).toBe('red')
    expect(shape.rotation).toBeCloseTo(Math.PI / 4)

    const textRes: any = await canvasBridge.handle('canvas_update_shape', { shapeId: 'shape:g1', text: '冒烟标签' })
    if (!textRes.ok) throw new Error(`text update failed: ${textRes.error}`)
    const after = editor.getShape(createShapeId('g1')) as any
    expect(JSON.stringify(after.props.richText)).toContain('冒烟标签')
  })

  it('canvas_update_shape text + resize in ONE call keeps the explicit size', async () => {
    // GeoShapeUtil.onBeforeUpdate re-measures the label when richText changes
    // and overrides w/h written in the SAME record — updateShapePartial must
    // sequence text-then-size so the caller's explicit size wins. Real tldraw
    // behavior a fake editor would never have caught.
    createGeo('g2', 0, 0)
    const res: any = await canvasBridge.handle('canvas_update_shape', { shapeId: 'shape:g2', text: '双写标签', w: 333, h: 222 })
    if (!res.ok) throw new Error(`combined update failed: ${res.error}`)
    const shape = editor.getShape(createShapeId('g2')) as any
    expect(shape.props.w).toBe(333)
    expect(shape.props.h).toBe(222)
    expect(JSON.stringify(shape.props.richText)).toContain('双写标签')
  })

  it('canvas_update_shape returns a structured error (not a crash) for an invalid color', async () => {
    createGeo('g1', 10, 10)
    const res: any = await canvasBridge.handle('canvas_update_shape', { shapeId: 'shape:g1', color: 'hotpink' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toBeTruthy()
    // The editor must still be usable afterwards (safeWrite kept it alive).
    expect(editor.getShape(createShapeId('g1'))).toBeTruthy()
  })

  it('canvas_arrange stack-horizontal really moves shapes; canvas_delete_shapes really deletes', async () => {
    createGeo('a', 0, 0)
    createGeo('b', 500, 300)
    createGeo('c', 900, 700)
    const arrange: any = await canvasBridge.handle('canvas_arrange', {
      shapeIds: ['shape:a', 'shape:b', 'shape:c'],
      operation: 'stack-horizontal',
      gap: 20,
    })
    expect(arrange.ok).toBe(true)
    // tldraw's stack only normalizes spacing along the main axis (it does NOT
    // align the cross axis): consecutive x gaps become exactly `gap`.
    const xs = ['a', 'b', 'c']
      .map((id) => (editor.getShape(createShapeId(id)) as any).x)
      .sort((m: number, n: number) => m - n)
    expect(Math.round(xs[1] - xs[0])).toBe(120) // 100 wide + 20 gap
    expect(Math.round(xs[2] - xs[1])).toBe(120)

    const del: any = await canvasBridge.handle('canvas_delete_shapes', { shapeIds: ['shape:c'] })
    expect(del).toMatchObject({ ok: true, deletedCount: 1 })
    expect(editor.getShape(createShapeId('c'))).toBeUndefined()
  })

  it('tiered snapshot on a real large canvas + focus_region + changedSinceLastSnapshot diff', async () => {
    // Half near the origin (in viewport), half stranded far away.
    for (let i = 0; i < TIERED_SNAPSHOT_THRESHOLD; i++) createGeo(`near${i}`, (i % 8) * 120, Math.floor(i / 8) * 100)
    for (let i = 0; i < 10; i++) createGeo(`far${i}`, 30000 + i * 150, 30000)

    const snap1: any = await canvasBridge.snapshot('thread-smoke', { screenshot: false })
    expect(snap1.detailLevel).toBe('tiered')
    expect(snap1.shapeCount).toBe(TIERED_SNAPSHOT_THRESHOLD + 10)
    expect(snap1.peripheralClusters!.length).toBeGreaterThan(0)
    expect(snap1.changedSinceLastSnapshot).toBeUndefined() // first look
    // The stranded shapes should also trip the far-from-origin lint.
    expect((snap1.lints ?? []).some((l: any) => l.kind === 'far-from-origin')).toBe(true)

    // Navigate to the far cluster like the agent would — VIRTUAL viewport:
    // the user's real camera must stay where it was.
    const cameraBefore = { ...editor.getCamera() }
    const farCluster = snap1.peripheralClusters!.find((c: any) => c.bounds.x > 10000)
    expect(farCluster).toBeTruthy()
    const focus: any = await canvasBridge.handle('canvas_focus_region', { bounds: farCluster.bounds, threadId: 'thread-smoke' })
    expect(focus).toMatchObject({ ok: true, mode: 'virtual' })
    expect(editor.getCamera()).toEqual(cameraBefore)

    // Mutate between looks: the diff must pick it up.
    editor.updateShape({ id: createShapeId('near0'), type: 'geo', x: 9999 })
    editor.deleteShapes([createShapeId('far9')])

    const snap2: any = await canvasBridge.snapshot('thread-smoke', { screenshot: false })
    const diff = snap2.changedSinceLastSnapshot
    expect(diff).toBeTruthy()
    expect(diff.updated).toContain(String(createShapeId('near0')))
    expect(diff.deleted).toContain(String(createShapeId('far9')))
    expect(diff.created).toEqual([])

    // The re-snapshot must now tier around the AGENT viewport: the far shapes
    // land in the blurry overview and the near ones fall out into clusters.
    expect(snap2.detailLevel).toBe('tiered')
    const overviewIds = new Set((snap2.shapes as Array<{ id: string }>).map((s) => s.id))
    expect(overviewIds.has(String(createShapeId('far0')))).toBe(true)
    expect(overviewIds.has(String(createShapeId('near1')))).toBe(false)
  })

  it('canvas_create_shape: geo with label / note / wrapped text survive real schema validation', async () => {
    const geo: any = await canvasBridge.handle('canvas_create_shape', {
      kind: 'geo', geoType: 'circle', x: 10, y: 20, w: 200, h: 200, text: '开始', color: 'blue', fill: 'semi',
    })
    if (!geo.ok) throw new Error(`geo create failed: ${geo.error}`)
    const geoShape = editor.getShape(geo.shape.id) as any
    expect(geoShape.props.geo).toBe('ellipse') // circle alias
    expect(geoShape.props.fill).toBe('semi')
    expect(JSON.stringify(geoShape.props.richText)).toContain('开始')

    const note: any = await canvasBridge.handle('canvas_create_shape', { kind: 'note', x: 300, y: 20, text: '便签', color: 'yellow' })
    if (!note.ok) throw new Error(`note create failed: ${note.error}`)
    expect((editor.getShape(note.shape.id) as any).type).toBe('note')

    const text: any = await canvasBridge.handle('canvas_create_shape', { kind: 'text', x: 0, y: 300, text: '一段会换行的说明文字', maxWidth: 240 })
    if (!text.ok) throw new Error(`text create failed: ${text.error}`)
    const textShape = editor.getShape(text.shape.id) as any
    expect(textShape.props.autoSize).toBe(false)
    expect(textShape.props.w).toBe(240)
  })

  it('canvas_create_shape: line from endpoints; arrow BINDS to shapes and follows them', async () => {
    const line: any = await canvasBridge.handle('canvas_create_shape', { kind: 'line', x1: 500, y1: 100, x2: 300, y2: 250 })
    if (!line.ok) throw new Error(`line create failed: ${line.error}`)
    const lineShape = editor.getShape(line.shape.id) as any
    expect(lineShape.x).toBe(300) // min of endpoints
    expect(lineShape.y).toBe(100)

    createGeo('src', 0, 0)
    createGeo('dst', 600, 400)
    const arrow: any = await canvasBridge.handle('canvas_create_shape', {
      kind: 'arrow', fromId: 'src', toId: 'shape:dst', text: '下一镜', // mixed sloppy ids on purpose
    })
    if (!arrow.ok) throw new Error(`arrow create failed: ${arrow.error}`)
    const bindings = editor.getBindingsFromShape(arrow.shape.id, 'arrow')
    expect(bindings.length).toBe(2)
    // Bound arrow must FOLLOW its target: move dst and the arrow's bounds change.
    const before = editor.getShapePageBounds(arrow.shape.id)!.w
    editor.updateShape({ id: createShapeId('dst'), type: 'geo', x: 1200 })
    const after = editor.getShapePageBounds(arrow.shape.id)!.w
    expect(after).toBeGreaterThan(before)
  })

  it('canvas_create_shape rejects bad input with structured errors (no crash)', async () => {
    const badGeo: any = await canvasBridge.handle('canvas_create_shape', { kind: 'geo', geoType: 'dodecahedron' })
    expect(badGeo.ok).toBe(false)
    expect(String(badGeo.error)).toContain('geoType')
    const badArrow: any = await canvasBridge.handle('canvas_create_shape', { kind: 'arrow', x1: 0, y1: 0 })
    expect(badArrow.ok).toBe(false)
    // Editor still alive.
    createGeo('alive', 0, 0)
    expect(editor.getShape(createShapeId('alive'))).toBeTruthy()
  })

  it('canvas_arrange z-order ops reorder real shapes without touching the camera', async () => {
    createGeo('bottom', 0, 0)
    createGeo('top', 20, 20) // created later → renders above
    const cameraBefore = { ...editor.getCamera() }
    const res: any = await canvasBridge.handle('canvas_arrange', { shapeIds: ['shape:bottom'], operation: 'bring-to-front' })
    expect(res).toMatchObject({ ok: true, arrangedCount: 1 })
    const order = editor.getCurrentPageShapesSorted().map((s) => String(s.id))
    expect(order.indexOf(String(createShapeId('bottom')))).toBeGreaterThan(order.indexOf(String(createShapeId('top'))))
    expect(editor.getCamera()).toEqual(cameraBefore)

    const back: any = await canvasBridge.handle('canvas_arrange', { shapeIds: ['shape:bottom'], operation: 'send-to-back' })
    expect(back.ok).toBe(true)
    const order2 = editor.getCurrentPageShapesSorted().map((s) => String(s.id))
    expect(order2.indexOf(String(createShapeId('bottom')))).toBeLessThan(order2.indexOf(String(createShapeId('top'))))
  })

  it('snapshot reports userViewportBounds (the USER camera, not the agent virtual viewport)', async () => {
    createGeo('g1', 0, 0)
    const snap: any = await canvasBridge.snapshot('thread-uservp', { screenshot: false })
    const vp = editor.getViewportPageBounds()
    expect(snap.userViewportBounds).toEqual({ x: Math.round(vp.x), y: Math.round(vp.y), w: Math.round(vp.w), h: Math.round(vp.h) })
  })

  it('full-mode snapshot of a small canvas carries no huge data: URL (P0 hygiene, real store)', async () => {
    createGeo('g1', 0, 0)
    // A file-card whose meta carries a big inline payload — the leak shape.
    const big = `data:image/png;base64,${'A'.repeat(400_000)}`
    editor.createShape({
      id: createShapeId('card'),
      type: 'file-card',
      x: 200,
      y: 0,
      props: { w: 260, h: 96, kind: 'file', title: 'a.png', assetPath: 'C:/a.png', assetUrl: big },
      meta: { assetUrl: big },
    } as never)
    const snap: any = await canvasBridge.snapshot('thread-smoke-2', { screenshot: false })
    expect(snap.detailLevel).toBe('full')
    expect(JSON.stringify(snap.shapes).length).toBeLessThan(100_000)
  })
})
