import { describe, it, expect, vi, afterEach } from 'vitest'
import { toUpstreamFetchableImage } from '../referenceTargets'

afterEach(() => vi.unstubAllGlobals())

/**
 * 「界面上显示的地址」不等于「上游能取到的地址」。这条转换有两个反方向的坑，
 * 两边都错得很安静：
 *  - http 转 base64 → 一张 2K 图内联进请求体是几 MB，而 seedream 那条链路明确
 *    要求 URL 直传；
 *  - blob 不转 → ApiService.normalizeImageSource 把它当成裸 base64，拼成
 *    `data:image/jpeg;base64,blob:http://…`，请求照发、错误不指向真因。
 */
describe('toUpstreamFetchableImage', () => {
  it('http(s) 原样透传 —— 上游自己去 fetch，别在这儿内联成 base64', async () => {
    const url = 'https://cos.example.com/image-history/a.png'
    expect(await toUpstreamFetchableImage(url)).toBe(url)
    expect(await toUpstreamFetchableImage('http://x/y.png')).toBe('http://x/y.png')
  })

  it('data: 原样透传（已经自包含）', async () => {
    const url = 'data:image/png;base64,AAAA'
    expect(await toUpstreamFetchableImage(url)).toBe(url)
  })

  it('blob: 必须转成 data URL —— 它只在本渲染进程内有效', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) })),
    )
    const out = await toUpstreamFetchableImage('blob:http://localhost/abc-123')
    expect(out.startsWith('data:')).toBe(true)
    expect(out).not.toContain('blob:')
  })

  it('取数据失败时回落原值 —— 让上游报一个真实的错，别在这儿造一个假的', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const url = 'blob:http://localhost/gone'
    expect(await toUpstreamFetchableImage(url)).toBe(url)
  })

  it('空值不炸', async () => {
    expect(await toUpstreamFetchableImage('')).toBe('')
  })
})
