import { afterEach, describe, expect, it } from 'vitest'
import { insertImageAt } from '../shapeOps'
import { canvasBridge } from '../canvasBridge'

// Dragging a file from the workspace tree onto the canvas → insertImageAt (image)
// or insertVideo (video), placed at the drop's page point. Passing explicit w/h
// skips the <img>/<video> dimension probe (jsdom can't decode media).

type Call = string
function makeEditor(): { editor: any; calls: Call[]; shapes: any[] } {
  const calls: Call[] = []
  const shapes: any[] = []
  let depth = 0
  const tag = (name: string): string => (depth > 0 ? `${name}@run` : name)
  const editor = {
    getShape: () => undefined,
    getShapePageBounds: () => ({ x: 0, y: 0, w: 100, h: 100 }),
    createAssets: (assets: any[]) => {
      calls.push(tag('asset'))
      shapes.push(...assets)
    },
    createShape: (shape: { type: string }) => {
      calls.push(tag(`shape:${shape.type}`))
      shapes.push(shape)
    },
    bringToFront: () => calls.push(tag('bringToFront')),
    select: () => calls.push(tag('select')),
    run: (fn: () => void) => {
      depth += 1
      try {
        fn()
      } finally {
        depth -= 1
      }
    },
  }
  return { editor, calls, shapes }
}

describe('insertImageAt (workspace file → canvas)', () => {
  it('creates an image asset + image shape atomically at the drop point', async () => {
    const { editor, calls, shapes } = makeEditor()
    const res = await insertImageAt(editor, { assetUrl: 'data:image/png;base64,QUJD', assetPath: 'C:/a.png', x: 300, y: 120, w: 100, h: 100, title: 'a.png' })
    expect(calls).toContain('asset@run')
    expect(calls).toContain('shape:image@run')
    expect(calls.filter((c) => !c.endsWith('@run'))).toEqual([])
    // The image ASSET also has type:'image'; the shape is the non-asset record.
    const shape = shapes.find((s) => s.type === 'image' && s.typeName !== 'asset')
    expect(shape.x).toBe(300)
    expect(shape.y).toBe(120)
    expect(res.imageShapeId).toBe(String(shape.id))
  })

  it('caps a large image to 512px on the longest edge (aspect preserved)', async () => {
    const { editor, shapes } = makeEditor()
    await insertImageAt(editor, { assetUrl: 'data:image/png;base64,QUJD', x: 0, y: 0, w: 2048, h: 1024 })
    const shape = shapes.find((s) => s.type === 'image' && s.typeName !== 'asset')
    expect(shape.props.w).toBe(512)
    expect(shape.props.h).toBe(256)
  })
})

describe('canvasBridge.insertFileAt routing', () => {
  afterEach(() => canvasBridge.setEditor(null))

  it('drops an AUDIO file as a file-card carrying its real workspace path', async () => {
    const { editor, shapes } = makeEditor()
    canvasBridge.setEditor(editor)
    const res = await canvasBridge.insertFileAt('D:/work/theme.mp3', { x: 40, y: 60 })
    expect(res).toEqual({ ok: true, kind: 'audio' })
    const card = shapes.find((s) => s.type === 'file-card' && s.typeName !== 'asset')
    expect(card.meta.assetKind).toBe('audio')
    expect(card.meta.assetPath).toBe('D:/work/theme.mp3')
    expect(card.props.kind).toBe('audio')
    expect(card.props.assetPath).toBe('D:/work/theme.mp3')
  })

  it('drops ANY other file (.txt/.zip/.pdf) as a file-card with its path', async () => {
    const { editor, shapes } = makeEditor()
    canvasBridge.setEditor(editor)
    const res = await canvasBridge.insertFileAt('C:/notes.txt', { x: 0, y: 0 })
    expect(res).toEqual({ ok: true, kind: 'file' })
    const card = shapes.find((s) => s.type === 'file-card' && s.typeName !== 'asset')
    expect(card.meta.assetKind).toBe('file')
    expect(card.meta.assetPath).toBe('C:/notes.txt')
    expect(card.props.kind).toBe('file')
  })
})
