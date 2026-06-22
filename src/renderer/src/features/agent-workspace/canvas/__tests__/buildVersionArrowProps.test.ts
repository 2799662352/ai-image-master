import { describe, expect, it } from 'vitest'
import { buildVersionArrowProps } from '../shapeOps'

// tldraw v5.1.1 arrowShapeProps (from @tldraw/tlschema TLArrowShape). The
// AddRichText migration removed `text` in favor of `richText`, so any `text`
// prop on an arrow throws ValidationError and crashes the canvas. This test
// guards createImageVersion's arrow against reintroducing a non-schema prop.
const VALID_ARROW_PROP_KEYS = new Set([
  'kind',
  'labelColor',
  'color',
  'fill',
  'dash',
  'size',
  'arrowheadStart',
  'arrowheadEnd',
  'font',
  'start',
  'end',
  'bend',
  'richText',
  'labelPosition',
  'scale',
  'elbowMidPoint',
])

describe('buildVersionArrowProps', () => {
  it('never includes the legacy `text` prop (the crash regression)', () => {
    expect('text' in buildVersionArrowProps()).toBe(false)
  })

  it('only uses keys present in tldraw v5 arrowShapeProps', () => {
    const invalid = Object.keys(buildVersionArrowProps()).filter((k) => !VALID_ARROW_PROP_KEYS.has(k))
    expect(invalid).toEqual([])
  })
})
