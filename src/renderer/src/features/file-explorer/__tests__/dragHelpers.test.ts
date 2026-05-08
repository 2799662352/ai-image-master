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
  it('round-trips a file path through serialize/parse', () => {
    const dt = makeDataTransfer()
    serializeFileDrag(dt, 'D:\\foo\\bar.ts')
    expect(parseFileDrop(dt)).toBe('D:\\foo\\bar.ts')
  })

  it('round-trips a quote block', () => {
    const dt = makeDataTransfer()
    const q = '```ts:1-3:foo.ts\nx\n```'
    serializeQuoteDrag(dt, q)
    expect(parseQuoteDrop(dt)).toBe(q)
  })

  it('parseFileDrop returns null when no path payload', () => {
    const dt = makeDataTransfer()
    expect(parseFileDrop(dt)).toBeNull()
  })

  it('parseQuoteDrop returns null when no quote payload', () => {
    const dt = makeDataTransfer()
    expect(parseQuoteDrop(dt)).toBeNull()
  })
})
