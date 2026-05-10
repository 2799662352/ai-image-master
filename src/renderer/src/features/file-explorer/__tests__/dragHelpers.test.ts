import { describe, it, expect } from 'vitest'
import { serializeFileDrag, parseFileDrop, serializeQuoteDrag, parseQuoteDrop } from '../dragHelpers'

function makeDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  } as DataTransfer
}

describe('drag helpers', () => {
  it('round-trips a single file path through serialize/parse', () => {
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:\\foo\\bar.ts'])
    expect(parseFileDrop(dt)).toEqual(['D:\\foo\\bar.ts'])
  })

  it('round-trips multiple file paths in original order', () => {
    const dt = makeDataTransfer()
    const paths = ['D:\\a.ts', 'D:\\sub\\b.ts', 'D:\\c.png']
    serializeFileDrag(dt, paths)
    expect(parseFileDrop(dt)).toEqual(paths)
  })

  it('writes a newline-joined text/plain fallback', () => {
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:\\a.ts', 'D:\\b.ts'])
    expect(dt.getData('text/plain')).toBe('D:\\a.ts\nD:\\b.ts')
  })

  it('serializeFileDrag with empty array is a no-op', () => {
    const dt = makeDataTransfer()
    serializeFileDrag(dt, [])
    expect(parseFileDrop(dt)).toEqual([])
  })

  it('round-trips a quote block', () => {
    const dt = makeDataTransfer()
    const q = '```ts:1-3:foo.ts\nx\n```'
    serializeQuoteDrag(dt, q)
    expect(parseQuoteDrop(dt)).toBe(q)
  })

  it('parseFileDrop returns empty array when no path payload', () => {
    const dt = makeDataTransfer()
    expect(parseFileDrop(dt)).toEqual([])
  })

  it('parseQuoteDrop returns null when no quote payload', () => {
    const dt = makeDataTransfer()
    expect(parseQuoteDrop(dt)).toBeNull()
  })
})
