// @vitest-environment node
//
// 深度捕捉的源视频怎么变成上游能拉的地址。
//
// 上游(RunningHub)只吃**可下载的公网 http(s)**。本机路径必须先中转到 COS,而且中转
// 失败时**不能**降级成 data: 内联 —— 那只会把「COS 不通」这个真实原因,换成上游一句
// 看不懂的 400(`resolveMediaUrl` 的 `noInline` 就是为只收 https 的调用方留的)。
//
// 这里只验「给 resolveMediaUrl 的选项」这一件事:别的模型必须一个字节不变。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveMediaUrl = vi.fn()

vi.mock('../mediaResolve', () => ({
  resolveMediaUrl: (...a: unknown[]) => resolveMediaUrl(...a),
  MAX_INLINE_FILE_BYTES: 512 * 1024,
}))

vi.mock('../promptReferences', () => ({
  normalizeSeedancePromptReferences: (t: string) => t,
}))

beforeEach(() => {
  resolveMediaUrl.mockReset()
  resolveMediaUrl.mockImplementation(async (src: string) => `https://cos/${src}`)
})

describe('buildContent — 深度捕捉的中转选项', () => {
  it('depth:源视频先中转(alwaysRelay)且中转失败不降级内联(noInline)', async () => {
    const { __buildContentForTests } = await import('../runtime')

    const content = await __buildContentForTests({
      prompt: '深度捕捉',
      model: 'depth',
      referenceVideos: ['D:/clips/run.mp4'],
    })

    expect(resolveMediaUrl).toHaveBeenCalledTimes(1)
    const [src, label, , options] = resolveMediaUrl.mock.calls[0]
    expect(src).toBe('D:/clips/run.mp4')
    expect(label).toBe('referenceVideos[0]')
    expect(options).toEqual({ alwaysRelay: true, noInline: true })
    expect(content.map((c) => c.type)).toEqual(['text', 'video_url'])
  })

  it('万相:只有 alwaysRelay,没有 noInline —— 它的降级行为不能被连带改掉', async () => {
    const { __buildContentForTests } = await import('../runtime')
    await __buildContentForTests({ prompt: 'p', model: 'wan3', referenceImages: ['a.png'] })
    expect(resolveMediaUrl.mock.calls[0][3]).toEqual({ alwaysRelay: true })
  })

  it('Seedance:不传选项(保留 ≤512KB 内联捷径),与改动前逐字节相同', async () => {
    const { __buildContentForTests } = await import('../runtime')
    for (const model of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      resolveMediaUrl.mockClear()
      await __buildContentForTests({ prompt: 'p', model, referenceImages: ['a.png'] })
      expect(resolveMediaUrl.mock.calls[0][3], model).toBeUndefined()
    }
  })

  it('withSourceVideoRelay:只对源视频变换型模型叠加,且保留调用方已有的选项', async () => {
    const { withSourceVideoRelay } = await import('../runtime')
    expect(withSourceVideoRelay('depth', undefined)).toEqual({ alwaysRelay: true, noInline: true })
    expect(withSourceVideoRelay('depth', { alwaysRelay: true })).toEqual({
      alwaysRelay: true,
      noInline: true,
    })
    expect(withSourceVideoRelay('2.0', undefined)).toBeUndefined()
    expect(withSourceVideoRelay(undefined, undefined)).toBeUndefined()
    const base = { alwaysRelay: true }
    expect(withSourceVideoRelay('wan3', base)).toBe(base)
  })
})
