import { describe, it, expect } from 'vitest'
import { toRenderableUri } from '../uri'

/**
 * `local-file` is registered as a *standard* scheme (protocolHandler.ts), so
 * Chromium parses `local-file:///X…` like `http:///X…`: the run of slashes is
 * collapsed and `X` becomes the authority. Verified in a real Electron 43
 * BrowserWindow (file:// page origin, same webPreferences as the packaged app):
 *
 *   local-file:///C%3A/…  → `new URL()` INVALID (host "C:" after percent-decode
 *                           has a forbidden code point); `<img>` broken,
 *                           `<audio>` "Media load rejected by URL safety check",
 *                           the protocol handler is never even called.
 *   local-file:///C:/…    → host "c", path "/…"; `<img>` decodes, `<audio>` plays;
 *                           the handler restores the drive from the 1-letter host.
 *
 * So the drive colon must stay RAW. These tests pin that contract.
 */
describe('toRenderableUri', () => {
  it('keeps the Windows drive colon raw when the path uses backslashes', () => {
    expect(toRenderableUri('D:\\Users\\u\\AppData\\img.png')).toBe(
      'local-file:///D:/Users/u/AppData/img.png',
    )
  })

  it('keeps the Windows drive colon raw when the path uses forward slashes', () => {
    expect(toRenderableUri('D:/Users/u/img.png')).toBe('local-file:///D:/Users/u/img.png')
  })

  it('never percent-encodes the drive colon (the %3A form is an invalid URL)', () => {
    expect(toRenderableUri('C:\\a\\b.png')).not.toContain('%3A')
  })

  it('leaves a canonical local-file URL alone', () => {
    expect(toRenderableUri('local-file:///D:/x/y.png')).toBe('local-file:///D:/x/y.png')
  })

  it('heals the legacy %3A drive-colon form persisted by older builds', () => {
    expect(toRenderableUri('local-file:///D%3A/x/y.png')).toBe('local-file:///D:/x/y.png')
    expect(toRenderableUri('local-file:///d%3a/x/y.png')).toBe('local-file:///d:/x/y.png')
  })

  it('folds the Chromium-normalized host-letter form back to the canonical one', () => {
    // `img.src` / request URLs come back as `local-file://c/…` (host lower-cased).
    expect(toRenderableUri('local-file://c/Users/u/x.png')).toBe('local-file:///C:/Users/u/x.png')
  })

  it('does not touch the streamable media host form', () => {
    const media = `local-file://media/?p=${encodeURIComponent('D:\\clips\\a.mp4')}`
    expect(toRenderableUri(media)).toBe(media)
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
  it('converts a Windows file:/// URL to local-file:/// (drive colon kept raw)', () => {
    expect(
      toRenderableUri('file:///C:/Users/27996/AppData/Roaming/app/agent/uploads/a.png'),
    ).toBe('local-file:///C:/Users/27996/AppData/Roaming/app/agent/uploads/a.png')
  })

  it('percent-decodes the drive colon form (file:///C%3A/…)', () => {
    expect(toRenderableUri('file:///C%3A/u/x.png')).toBe('local-file:///C:/u/x.png')
  })

  it('converts a POSIX file:/// URL to local-file:///', () => {
    expect(toRenderableUri('file:///home/u/x.png')).toBe('local-file:////home/u/x.png')
  })

  it('decodes percent-encoded spaces in a file:// URL', () => {
    expect(toRenderableUri('file:///C:/My%20Pics/a%20b.png')).toBe(
      'local-file:///C:/My Pics/a b.png',
    )
  })
})
