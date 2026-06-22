import { describe, expect, it } from 'vitest'
import { insertVideo } from '../shapeOps'

// `insert_video` puts a generated video file on the canvas as a real tldraw
// `video` shape (asset + shape), mirroring the image insert path. Passing
// explicit w/h skips the <video> metadata probe (jsdom can't decode video), so
// the test is deterministic and fast.

type Call = string
function makeEditor(opts: { failOn?: 'video' } = {}): { editor: any; calls: Call[]; shapes: any[] } {
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
      if (opts.failOn === shape.type) throw new Error(`boom ${shape.type}`)
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

describe('insertVideo', () => {
  it('creates a video asset + video shape inside one editor.run transaction', async () => {
    const { editor, calls } = makeEditor()
    await insertVideo(editor, { assetUrl: 'data:video/mp4;base64,QUJD', assetPath: 'C:/clip.mp4', w: 1280, h: 720, title: 'Clip' })
    expect(calls).toContain('asset@run')
    expect(calls).toContain('shape:video@run')
    // Every mutating call shares the transaction (atomic, like the image path).
    expect(calls.filter((c) => !c.endsWith('@run'))).toEqual([])
  })

  it('builds a tldraw video asset (type video, isAnimated) and a video shape referencing it', async () => {
    const { editor, shapes } = makeEditor()
    const res = await insertVideo(editor, { assetUrl: 'data:video/mp4;base64,QUJD', assetPath: 'C:/clip.mp4', w: 1280, h: 720 })
    const asset = shapes.find((s) => s.typeName === 'asset')
    expect(asset.type).toBe('video')
    expect(asset.props.isAnimated).toBe(true)
    expect(asset.props.mimeType).toBe('video/mp4')
    // The video ASSET also has type:'video'; the shape is the non-asset record.
    const shape = shapes.find((s) => s.type === 'video' && s.typeName !== 'asset')
    expect(shape.props.assetId).toBe(asset.id)
    expect(res.videoShapeId).toBe(String(shape.id))
  })

  it('caps a large video to a sensible on-canvas size while keeping aspect', async () => {
    const { editor, shapes } = makeEditor()
    await insertVideo(editor, { assetUrl: 'data:video/mp4;base64,QUJD', w: 1920, h: 1080 })
    const shape = shapes.find((s) => s.type === 'video' && s.typeName !== 'asset')
    // longest edge capped to 640, 16:9 preserved → 640 x 360
    expect(shape.props.w).toBe(640)
    expect(shape.props.h).toBe(360)
  })
})
