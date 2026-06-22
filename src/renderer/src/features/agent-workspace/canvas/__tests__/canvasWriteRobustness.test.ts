import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImageVersion, insertImageIntoHolder } from '../shapeOps'
import { canvasBridge } from '../canvasBridge'

/**
 * jsdom never fires <img> load events, so loadImageDimensions() would hang.
 * Stub Image to resolve onload synchronously (microtask) with fixed dimensions.
 */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 100
  naturalHeight = 200
  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

type Call = string
function makeEditor(opts: { failOn?: 'arrow' | 'image' } = {}): { editor: any; calls: Call[] } {
  const calls: Call[] = []
  let depth = 0
  const tag = (name: string): string => (depth > 0 ? `${name}@run` : name)
  const editor = {
    getShape: () => ({ id: 'shape:src', meta: { version: 1, holderId: 'shape:h' }, props: { w: 100, h: 100 } }),
    getShapePageBounds: () => ({ x: 0, y: 0, w: 100, h: 100 }),
    createAssets: () => {
      calls.push(tag('asset'))
    },
    createShape: (shape: { type: string }) => {
      calls.push(tag(`shape:${shape.type}`))
      if (opts.failOn === shape.type) throw new Error(`boom ${shape.type}`)
    },
    createBindings: () => {
      calls.push(tag('bindings'))
    },
    bringToFront: () => {
      calls.push(tag('bringToFront'))
    },
    select: () => {
      calls.push(tag('select'))
    },
    // tldraw's real run() batches into ONE transaction that rolls back on throw.
    run: (fn: () => void) => {
      depth += 1
      try {
        fn()
      } finally {
        depth -= 1
      }
    },
  }
  return { editor, calls }
}

describe('E1: atomic writes wrap all creates in a single editor.run transaction', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('createImageVersion runs asset+image+arrow creates inside editor.run (so a late throw rolls back)', async () => {
    const { editor, calls } = makeEditor()
    await createImageVersion(editor, { sourceShapeId: 'shape:src', assetUrl: 'data:image/png;base64,QUJD' })
    // Every mutating call must be tagged @run — proving they share one transaction.
    expect(calls).toContain('asset@run')
    expect(calls).toContain('shape:image@run')
    expect(calls).toContain('shape:arrow@run')
    // The version-arrow bindings must also be created inside the same transaction.
    expect(calls).toContain('bindings@run')
    expect(calls.filter((c) => !c.endsWith('@run'))).toEqual([])
  })

  it('insertImageIntoHolder runs asset+image creates inside editor.run', async () => {
    const { editor, calls } = makeEditor()
    await insertImageIntoHolder(editor, { holderShapeId: 'shape:h', assetUrl: 'data:image/png;base64,QUJD' })
    expect(calls).toContain('asset@run')
    expect(calls).toContain('shape:image@run')
    expect(calls.filter((c) => !c.endsWith('@run'))).toEqual([])
  })
})

describe('E2: a failed write returns a structured error instead of crashing the canvas', () => {
  afterEach(() => {
    canvasBridge.setEditor(null)
  })

  it('create_image_holder returns {failed:true} (does not throw) when the shape is rejected', async () => {
    const editor = {
      getShape: () => undefined,
      createShape: () => {
        throw new Error('validation boom')
      },
      select: () => {},
    }
    canvasBridge.setEditor(editor as never)
    const res = (await canvasBridge.handle('create_image_holder', {})) as {
      failed?: boolean
      tool?: string
      error?: string
    }
    expect(res.failed).toBe(true)
    expect(res.tool).toBe('create_image_holder')
    expect(res.error).toContain('validation boom')
  })

  it('keeps the editor mounted after a failed write (canvas stays usable, not bricked)', async () => {
    const editor = {
      getShape: () => undefined,
      createShape: () => {
        throw new Error('validation boom')
      },
      select: () => {},
    }
    canvasBridge.setEditor(editor as never)
    await canvasBridge.handle('create_image_holder', {})
    // The editor must NOT have been nulled by the failure — waitForEditor resolves immediately.
    await expect(canvasBridge.waitForEditor(10)).resolves.toBe(editor)
  })
})
