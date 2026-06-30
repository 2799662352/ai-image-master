import { describe, it, expect } from 'vitest'
import { toRenderableUri } from '../uri'

describe('toRenderableUri', () => {
  it('encodes Windows drive colon when path uses backslashes', () => {
    expect(toRenderableUri('D:\\Users\\u\\AppData\\img.png')).toBe(
      'local-file:///D%3A/Users/u/AppData/img.png',
    )
  })

  it('encodes Windows drive colon when path uses forward slashes', () => {
    expect(toRenderableUri('D:/Users/u/img.png')).toBe('local-file:///D%3A/Users/u/img.png')
  })

  it('re-encodes drive colon in already-formed local-file URLs', () => {
    expect(toRenderableUri('local-file:///D:/x/y.png')).toBe('local-file:///D%3A/x/y.png')
  })

  it('leaves already-encoded local-file URLs alone', () => {
    expect(toRenderableUri('local-file:///D%3A/x/y.png')).toBe('local-file:///D%3A/x/y.png')
  })

  it('wraps POSIX absolute path', () => {
    expect(toRenderableUri('/home/u/img.png')).toBe('local-file:////home/u/img.png')
  })

  it('passes through blob:, data:, and http(s)://', () => {
    expect(toRenderableUri('blob:abc')).toBe('blob:abc')
    expect(toRenderableUri('data:image/png;base64,xx')).toBe('data:image/png;base64,xx')
    expect(toRenderableUri('https://x.com/y.png')).toBe('https://x.com/y.png')
  })

  it('returns input unchanged when not a recognized shape', () => {
    expect(toRenderableUri('relative/path.png')).toBe('relative/path.png')
  })

  // 回归：codex 重载时 R2/COS 未结算 → anchor.paths 回退为 file:///… ；沙箱渲染进程
  // 不允许 <img src="file://…">（"Not allowed to load local resource"）。渲染层必须把
  // file:// 归一化成 local-file://（→ 自定义协议/IPC）。
  it('converts a Windows file:/// URL to local-file:/// (encoded drive colon)', () => {
    expect(
      toRenderableUri('file:///C:/Users/27996/AppData/Roaming/app/agent/uploads/a.png'),
    ).toBe('local-file:///C%3A/Users/27996/AppData/Roaming/app/agent/uploads/a.png')
  })

  it('percent-decodes the drive colon form (file:///C%3A/…)', () => {
    expect(toRenderableUri('file:///C%3A/u/x.png')).toBe('local-file:///C%3A/u/x.png')
  })

  it('converts a POSIX file:/// URL to local-file:///', () => {
    expect(toRenderableUri('file:///home/u/x.png')).toBe('local-file:////home/u/x.png')
  })

  it('decodes percent-encoded spaces in a file:// URL', () => {
    expect(toRenderableUri('file:///C:/My%20Pics/a%20b.png')).toBe(
      'local-file:///C%3A/My Pics/a b.png',
    )
  })
})
