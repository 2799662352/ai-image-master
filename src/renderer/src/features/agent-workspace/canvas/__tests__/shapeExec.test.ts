import { describe, expect, it, vi } from 'vitest'
import { EDITOR_API_SPEC, createExecHelpers, executeCanvasCode, searchEditorApi } from '../shapeExec'

/**
 * canvas_exec / canvas_search escape hatch (gap-analysis §4.B).
 * Per the product owner the exec is INTENTIONALLY UNRESTRICTED (no fetch/timer
 * sandboxing); these tests pin the contract: code runs against the live editor +
 * injected helpers, results serialize, errors come back structured (never throw
 * out and crash the canvas), and search queries the curated Editor API spec.
 */

function fakeEditor() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
    return undefined
  }
  return {
    calls,
    createShape: rec('createShape'),
    createBindings: rec('createBindings'),
    deleteShapes: rec('deleteShapes'),
    select: rec('select'),
    sendToBack: rec('sendToBack'),
    groupShapes: rec('groupShapes'),
    getShapesPageBounds: vi.fn(() => ({ x: 0, y: 0, w: 100, h: 50 })),
    getCurrentPageShapes: vi.fn(() => [{ id: 'shape:a' }, { id: 'shape:b' }]),
  } as never
}

describe('executeCanvasCode (unrestricted)', () => {
  it('runs code and serializes the return value', async () => {
    const res = await executeCanvasCode(fakeEditor(), 'return 19 + 23')
    expect(res.success).toBe(true)
    expect(res.result).toBe(42)
  })

  it('exposes the live editor to the code', async () => {
    const editor = fakeEditor()
    const res = await executeCanvasCode(editor, 'return editor.getCurrentPageShapes().length')
    expect(res.success).toBe(true)
    expect(res.result).toBe(2)
  })

  it('injects exec helpers (createShapeId / boxShapes) as bare names', async () => {
    const editor = fakeEditor()
    const res = await executeCanvasCode(
      editor,
      "boxShapes(['shape:a','shape:b'], { text: 'Group' }); return typeof createShapeId",
    )
    expect(res.success).toBe(true)
    expect(res.result).toBe('function')
    // boxShapes draws a geo box + groups the shapes
    expect((editor as never as { calls: Array<{ method: string }> }).calls.some((c) => c.method === 'createShape')).toBe(true)
    expect((editor as never as { calls: Array<{ method: string }> }).calls.some((c) => c.method === 'groupShapes')).toBe(true)
  })

  it('supports await inside the code', async () => {
    const res = await executeCanvasCode(fakeEditor(), 'return await Promise.resolve(7)')
    expect(res.success).toBe(true)
    expect(res.result).toBe(7)
  })

  it('returns a structured error instead of throwing (never crashes the canvas)', async () => {
    const res = await executeCanvasCode(fakeEditor(), "throw new Error('boom')")
    expect(res.success).toBe(false)
    expect(res.error).toContain('boom')
  })

  it('reports syntax errors as a failed result', async () => {
    const res = await executeCanvasCode(fakeEditor(), 'return (((')
    expect(res.success).toBe(false)
    expect(typeof res.error).toBe('string')
  })
})

describe('createExecHelpers', () => {
  it('createArrowBetweenShapes binds an arrow start→from / end→to', () => {
    const editor = fakeEditor()
    const helpers = createExecHelpers(editor)
    helpers.createArrowBetweenShapes('shape:a', 'shape:b')
    const calls = (editor as never as { calls: Array<{ method: string; args: unknown[] }> }).calls
    expect(calls.some((c) => c.method === 'createShape')).toBe(true)
    const bindCall = calls.find((c) => c.method === 'createBindings')
    expect(bindCall).toBeTruthy()
    const bindings = bindCall!.args[0] as Array<{ props: { terminal: string }; toId: string }>
    expect(bindings.map((b) => b.props.terminal).sort()).toEqual(['end', 'start'])
  })
})

describe('searchEditorApi', () => {
  it('queries the curated spec and returns matches', async () => {
    const res = await searchEditorApi("return spec.members.filter(m => m.name === 'createShape').map(m => m.name)")
    expect(res.success).toBe(true)
    expect(res.result).toEqual(['createShape'])
  })

  it('exposes shape types and helpers in the spec', async () => {
    const res = await searchEditorApi('return { shapeTypes: spec.types.shapeTypes, helperCount: spec.helpers.length }')
    expect(res.success).toBe(true)
    const out = res.result as { shapeTypes: string[]; helperCount: number }
    expect(out.shapeTypes).toContain('image')
    expect(out.shapeTypes).toContain('arrow')
    expect(out.helperCount).toBeGreaterThan(0)
  })

  it('returns a structured error for bad query code', async () => {
    const res = await searchEditorApi('return spec.nope.boom()')
    expect(res.success).toBe(false)
    expect(typeof res.error).toBe('string')
  })

  it('exports a non-empty curated spec', () => {
    expect(EDITOR_API_SPEC.members.length).toBeGreaterThan(5)
    expect(EDITOR_API_SPEC.types.shapeTypes.length).toBeGreaterThan(3)
  })
})
