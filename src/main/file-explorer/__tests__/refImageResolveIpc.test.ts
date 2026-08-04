// @vitest-environment node
//
// `media:resolve-ref-image` — 把 MCP 参考图的本地路径换成 COS URL。
//
// 这条通道比 `attachments:read-thumb` 危险:后者只把字节回传给渲染进程,前者会把
// 文件**上传到公开 COS 桶**。所以白名单不是可选项 —— 用同一套 mediaPathValidation
// 原语,并且额外只放行图片(参考图就是图片,没有理由放过 zip/pmx 这些)。

import { describe, expect, it, vi, beforeEach } from 'vitest'

const resolveMediaUrl = vi.fn()

vi.mock('../../services/seedance/mediaResolve', () => ({
  resolveMediaUrl: (...a: unknown[]) => resolveMediaUrl(...a),
}))

beforeEach(() => {
  resolveMediaUrl.mockReset()
})

describe('resolveRefImage — 直接透传', () => {
  it('http(s) / data: 原样返回,不碰磁盘白名单也不中转', async () => {
    const { resolveRefImage } = await import('../refImageResolveIpc')

    expect(await resolveRefImage('https://cdn/x.png')).toEqual({
      ok: true,
      url: 'https://cdn/x.png',
    })
    expect(resolveMediaUrl).not.toHaveBeenCalled()
  })
})

describe('resolveRefImage — 本地路径走 COS', () => {
  it('图片路径 → alwaysRelay 中转,拿回 URL', async () => {
    const { resolveRefImage } = await import('../refImageResolveIpc')
    resolveMediaUrl.mockResolvedValue('https://bucket/relayed.png')

    const out = await resolveRefImage('D:\\shots\\hero.png')

    expect(out).toEqual({ ok: true, url: 'https://bucket/relayed.png' })
    // 必须显式要求一律中转 —— 默认的 512KB 内联线是视频那边的口径。
    expect(resolveMediaUrl.mock.calls[0][3]).toEqual({ alwaysRelay: true })
    // mime 由扩展名推出,交给 resolveMediaUrl 生成 COS Key。
    expect(resolveMediaUrl.mock.calls[0][2]).toBe('image/png')
  })

  it('中转抛错时返回 ok:false,不把异常丢过 IPC 边界', async () => {
    const { resolveRefImage } = await import('../refImageResolveIpc')
    resolveMediaUrl.mockRejectedValue(new Error('COS down'))

    expect(await resolveRefImage('D:\\shots\\hero.png')).toEqual({
      ok: false,
      reason: 'COS down',
    })
  })
})

describe('resolveRefImage — 安全边界', () => {
  it('非图片扩展名一律拒绝 —— 别把任意文件传上公开桶', async () => {
    const { resolveRefImage } = await import('../refImageResolveIpc')

    for (const p of ['D:\\a\\secret.zip', 'D:\\a\\model.pmx', 'D:\\a\\clip.mp4']) {
      const out = await resolveRefImage(p)
      expect(out.ok, `${p} 不该放行`).toBe(false)
    }
    expect(resolveMediaUrl).not.toHaveBeenCalled()
  })

  it('无扩展名的路径被拒(~/.ssh/id_rsa 这类)', async () => {
    const { resolveRefImage } = await import('../refImageResolveIpc')

    expect((await resolveRefImage('/home/u/.ssh/id_rsa')).ok).toBe(false)
    expect(resolveMediaUrl).not.toHaveBeenCalled()
  })

  it('含 .. 的路径被拒', async () => {
    const { resolveRefImage } = await import('../refImageResolveIpc')

    expect((await resolveRefImage('D:\\uploads\\..\\..\\secret.png')).ok).toBe(false)
    expect(resolveMediaUrl).not.toHaveBeenCalled()
  })

  it('空/非字符串输入被拒,不抛', async () => {
    const { resolveRefImage } = await import('../refImageResolveIpc')

    expect((await resolveRefImage('')).ok).toBe(false)
    expect((await resolveRefImage(undefined as unknown as string)).ok).toBe(false)
  })
})

// `media:resolve-ref-media` —— 视频工作台「拖入即传」用的宽白名单版本。
// 与上面共用同一段逻辑,唯一的差别就是放行哪些 mime。
describe('resolveRefMedia — 放宽到图片/视频/音频', () => {
  it('视频与音频路径都能中转,mime 由扩展名推出', async () => {
    const { resolveRefMedia } = await import('../refImageResolveIpc')

    for (const [p, mime] of [
      ['D:\\v\\clip.mp4', 'video/mp4'],
      ['D:\\v\\clip.mov', 'video/quicktime'],
      ['D:\\v\\voice.mp3', 'audio/mpeg'],
      ['D:\\v\\voice.m4a', 'audio/mp4'],
      ['D:\\v\\hero.png', 'image/png'],
    ] as const) {
      resolveMediaUrl.mockReset()
      resolveMediaUrl.mockResolvedValue('https://bucket/relayed')

      expect(await resolveRefMedia(p), `${p} 该放行`).toEqual({
        ok: true,
        url: 'https://bucket/relayed',
      })
      expect(resolveMediaUrl.mock.calls[0][2]).toBe(mime)
      expect(resolveMediaUrl.mock.calls[0][3]).toEqual({ alwaysRelay: true })
    }
  })

  it('放宽的只是媒体类型,非媒体文件照旧拒绝', async () => {
    const { resolveRefMedia } = await import('../refImageResolveIpc')

    for (const p of ['D:\\a\\secret.zip', 'D:\\a\\model.pmx', 'D:\\a\\notes.txt']) {
      expect((await resolveRefMedia(p)).ok, `${p} 不该放行`).toBe(false)
    }
    expect(resolveMediaUrl).not.toHaveBeenCalled()
  })

  it('遍历段与空输入这两道闸与生图那条完全一致', async () => {
    const { resolveRefMedia } = await import('../refImageResolveIpc')

    expect((await resolveRefMedia('D:\\uploads\\..\\..\\secret.mp4')).ok).toBe(false)
    expect((await resolveRefMedia('')).ok).toBe(false)
    expect(resolveMediaUrl).not.toHaveBeenCalled()
  })

  it('生图那条入口仍然只认图片 —— 两个入口分开就是为了让默认最窄', async () => {
    const { resolveRefImage } = await import('../refImageResolveIpc')

    expect((await resolveRefImage('D:\\v\\clip.mp4')).ok).toBe(false)
    expect((await resolveRefImage('D:\\v\\voice.mp3')).ok).toBe(false)
    expect(resolveMediaUrl).not.toHaveBeenCalled()
  })
})
