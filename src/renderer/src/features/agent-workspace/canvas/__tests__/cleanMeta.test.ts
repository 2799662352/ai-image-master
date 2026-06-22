import { describe, expect, it } from 'vitest'
import { cleanMeta } from '../shapeOps'

// Mirrors @tldraw/validate's isValidJson: a meta object is rejected
// ("Expected json serializable value, got object") if ANY value is undefined,
// because isValidJson(undefined) === false and Object.values(...).every(...)
// then fails. We replicate the leaf rule to assert cleanMeta produces a
// tldraw-acceptable meta object.
function isValidJson(value: unknown): boolean {
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) return value.every(isValidJson)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value as Record<string, unknown>).every(isValidJson)
  }
  return false
}

describe('cleanMeta', () => {
  it('drops undefined values (the create_image_version regression)', () => {
    const meta = cleanMeta({ assetPath: 'C:/x.png', sourceRunId: undefined })
    expect(meta).toEqual({ assetPath: 'C:/x.png' })
    expect('sourceRunId' in meta).toBe(false)
  })

  it('produces a json-serializable meta tldraw accepts (no undefined leaf)', () => {
    // Raw meta with several absent optional fields would be rejected by tldraw.
    const raw = {
      aiCanvasRole: 'ai_image',
      holderId: undefined,
      parentShapeId: undefined,
      sourceRunId: undefined,
      version: 2,
      assetPath: 'C:/x.png',
      assetUrl: 'asset:1',
      title: 'AI 图片 v2',
    }
    expect(isValidJson(raw)).toBe(false)
    expect(isValidJson(cleanMeta(raw))).toBe(true)
  })

  it('keeps falsy-but-serializable values (0, empty string, false)', () => {
    const meta = cleanMeta({ version: 0, title: '', acceptsGeneratedImage: false, runId: undefined })
    expect(meta).toEqual({ version: 0, title: '', acceptsGeneratedImage: false })
  })
})
