import { describe, it, expect } from 'vitest'
import { toRenderableUri } from '../uri'

describe('toRenderableUri', () => {
  it('returns local-file URLs unchanged', () => {
    expect(toRenderableUri('local-file:///D:/x/y.png')).toBe('local-file:///D:/x/y.png')
  })

  it('wraps Windows absolute path with backslashes', () => {
    expect(toRenderableUri('D:\\Users\\u\\AppData\\img.png')).toBe('local-file:///D:/Users/u/AppData/img.png')
  })

  it('wraps Windows absolute path with forward slashes', () => {
    expect(toRenderableUri('D:/Users/u/img.png')).toBe('local-file:///D:/Users/u/img.png')
  })

  it('wraps POSIX absolute path', () => {
    expect(toRenderableUri('/home/u/img.png')).toBe('local-file:////home/u/img.png')
  })

  it('passes through blob: and data: and http(s)://', () => {
    expect(toRenderableUri('blob:abc')).toBe('blob:abc')
    expect(toRenderableUri('data:image/png;base64,xx')).toBe('data:image/png;base64,xx')
    expect(toRenderableUri('https://x.com/y.png')).toBe('https://x.com/y.png')
  })

  it('returns input unchanged when not a recognized shape', () => {
    expect(toRenderableUri('relative/path.png')).toBe('relative/path.png')
  })
})
