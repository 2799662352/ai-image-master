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
