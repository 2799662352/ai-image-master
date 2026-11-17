// 「只收公网链接」的渠道(Roneyun-cn)的素材规则 —— `asset://` 换回公网地址、换不出来就拦下。
//
// 这几条都没有本地信号会提示做错了:漏换一个 id,上游要么拒掉整次生成、要么少一份参考素材照常
// 扣费;换错了种类(拿视频的封面图顶替视频),上游照收、成片不对、不报错。所以逐条钉。

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertPublicUrlMediaOnly,
  pickPublicAssetUrl,
  replaceAssetRefsWithPublicUrls,
  unresolvedAssetRefsMessage,
} from '../assetPublicUrl'
import type { SeedanceContentItem } from '../types'

const text = (value: string): SeedanceContentItem => ({ type: 'text', text: value })
const image = (url: string, role = 'reference_image'): SeedanceContentItem =>
  ({ type: 'image_url', role, image_url: { url } }) as SeedanceContentItem
const video = (url: string): SeedanceContentItem =>
  ({ type: 'video_url', role: 'reference_video', video_url: { url } }) as SeedanceContentItem
const audio = (url: string): SeedanceContentItem =>
  ({ type: 'audio_url', role: 'reference_audio', audio_url: { url } }) as SeedanceContentItem

const COS = (name: string): string => `https://cos.example.com/library/${name}`

/** 本机绑定表:id → 登记时的 URL。 */
const localTable = (table: Record<string, string>) => (assetId: string): string | null => table[assetId] ?? null

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pickPublicAssetUrl', () => {
  it('优先 cosUrl(后端转存的永久链),其次登记时的 URL', () => {
    expect(pickPublicAssetUrl({ cosUrl: COS('a.png'), URL: 'https://src.example.com/a.png' }, 'image')).toBe(COS('a.png'))
    expect(pickPublicAssetUrl({ URL: 'https://src.example.com/a.png' }, 'image')).toBe('https://src.example.com/a.png')
  })

  it('图片可以退到预览地址', () => {
    expect(pickPublicAssetUrl({ PreviewUrl: 'https://cdn.example.com/a.jpg' }, 'image')).toBe(
      'https://cdn.example.com/a.jpg',
    )
  })

  /**
   * 🧬 变异点:把 `kind === 'image'` 的限制去掉,这条必红。
   * 视频 / 音频的预览多半是一张封面 —— 顶上去就是「一张图冒充参考视频」。
   */
  it('视频 / 音频不拿预览地址顶替 —— 那多半是封面图', () => {
    expect(pickPublicAssetUrl({ PreviewUrl: 'https://cdn.example.com/cover.jpg' }, 'video')).toBeNull()
    expect(pickPublicAssetUrl({ PreviewUrl: 'https://cdn.example.com/cover.jpg' }, 'audio')).toBeNull()
  })

  it('不是 http(s) 的一律不算公网地址', () => {
    expect(pickPublicAssetUrl({ cosUrl: 'asset://x', URL: 'data:image/png;base64,AAAA' }, 'image')).toBeNull()
    expect(pickPublicAssetUrl({ cosUrl: '', URL: '   ' }, 'image')).toBeNull()
    expect(pickPublicAssetUrl({}, 'image')).toBeNull()
    // 前面的不合格时继续往后找,而不是直接放弃。
    expect(pickPublicAssetUrl({ cosUrl: 'C:\\a.png', URL: COS('a.png') }, 'image')).toBe(COS('a.png'))
  })
})

describe('replaceAssetRefsWithPublicUrls', () => {
  it('没有 asset:// 时原样返回同一个数组,不查任何东西', async () => {
    const content = [text('一只猫'), image(COS('cat.png'))]
    const lookupSourceUrl = vi.fn(() => null)
    const fetchAsset = vi.fn()

    const out = await replaceAssetRefsWithPublicUrls(content, { lookupSourceUrl, fetchAsset, channelLabel: 'Roneyun-cn' })

    expect(out).toBe(content)
    expect(lookupSourceUrl).not.toHaveBeenCalled()
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  /**
   * 顺序即编号:上游按 content[] 的下标解析「图片1 / 视频1」。
   * 🧬 变异点:把结果换成「先放换过的、再放没换的」之类的重排,这条必红。
   */
  it('三类素材都换,数组顺序与其它字段(role)原样保留', async () => {
    const content = [
      text('@图片1 走向 @图片2'),
      image('asset://img-1', 'first_frame'),
      image(COS('plain.png')),
      video('asset://vid-1'),
      audio('asset://aud-1'),
    ]

    const out = await replaceAssetRefsWithPublicUrls(content, {
      lookupSourceUrl: localTable({ 'img-1': COS('img-1.png'), 'vid-1': COS('vid-1.mp4'), 'aud-1': COS('aud-1.mp3') }),
      channelLabel: 'Roneyun-cn',
    })

    expect(out).toEqual([
      text('@图片1 走向 @图片2'),
      image(COS('img-1.png'), 'first_frame'),
      image(COS('plain.png')),
      video(COS('vid-1.mp4')),
      audio(COS('aud-1.mp3')),
    ])
    // 不改入参。
    expect(content[1]).toEqual(image('asset://img-1', 'first_frame'))
  })

  it('本机绑定表查得到就不去问素材库', async () => {
    const fetchAsset = vi.fn()

    const out = await replaceAssetRefsWithPublicUrls([image('asset://img-1')], {
      lookupSourceUrl: localTable({ 'img-1': COS('img-1.png') }),
      fetchAsset,
      channelLabel: 'Roneyun-cn',
    })

    expect(out).toEqual([image(COS('img-1.png'))])
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  it('本机没有绑定(别的设备入库的素材)时按 id 向素材库取,用它的 cosUrl', async () => {
    const fetchAsset = vi.fn(async (assetId: string) => ({ cosUrl: COS(`${assetId}.png`), URL: 'https://signed.example.com/x' }))

    const out = await replaceAssetRefsWithPublicUrls([image('asset://remote-1')], {
      lookupSourceUrl: () => null,
      fetchAsset,
      channelLabel: 'Roneyun-cn',
    })

    expect(out).toEqual([image(COS('remote-1.png'))])
    expect(fetchAsset).toHaveBeenCalledWith('remote-1')
  })

  /**
   * 绑定表的键是「登记时的原始 URL」,它可能是一段 data:(小图内联登记)。那不是公网地址,
   * 不能发给只收公网链接的渠道 —— 要接着问素材库。
   * 🧬 变异点:把 `isPublicUrl(local)` 换成 `local` 为真就用,这条必红。
   */
  it('本机绑定的是 data: 时不拿它当公网地址,接着问素材库', async () => {
    const fetchAsset = vi.fn(async () => ({ cosUrl: COS('from-library.png') }))

    const out = await replaceAssetRefsWithPublicUrls([image('asset://img-1')], {
      lookupSourceUrl: localTable({ 'img-1': 'data:image/png;base64,AAAA' }),
      fetchAsset,
      channelLabel: 'Roneyun-cn',
    })

    expect(out).toEqual([image(COS('from-library.png'))])
  })

  it('同一个 id 在卡上出现几次只查一次,每一处都换掉', async () => {
    const fetchAsset = vi.fn(async () => ({ cosUrl: COS('hero.png') }))

    const out = await replaceAssetRefsWithPublicUrls(
      [image('asset://hero', 'first_frame'), image('asset://hero', 'last_frame')],
      { lookupSourceUrl: () => null, fetchAsset, channelLabel: 'Roneyun-cn' },
    )

    expect(out).toEqual([image(COS('hero.png'), 'first_frame'), image(COS('hero.png'), 'last_frame')])
    expect(fetchAsset).toHaveBeenCalledTimes(1)
  })

  it('视频素材在素材库里只有预览图时算换不出来,不拿封面顶替', async () => {
    const fetchAsset = vi.fn(async () => ({ PreviewUrl: 'https://cdn.example.com/cover.jpg' }))

    await expect(
      replaceAssetRefsWithPublicUrls([video('asset://vid-1')], {
        lookupSourceUrl: () => null,
        fetchAsset,
        channelLabel: 'Roneyun-cn',
      }),
    ).rejects.toThrow('asset://vid-1')
  })

  /**
   * 有一个换不出来就整次拦下,不做「能换几个换几个」。
   * 🧬 变异点:去掉 `unresolved.length > 0` 的抛出,这条必红(会带着 asset://b 返回)。
   */
  it('有一个换不出来就整次拦下,按卡上的顺序列出是哪几个、说明怎么办', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // `c` 的查询先失败、`b` 后返回空 —— 报错顺序仍然要跟卡片走,而不是跟完成顺序走。
    const fetchAsset = vi.fn(async (assetId: string) => {
      if (assetId === 'c') throw Object.assign(new Error('not found'), { status: 404 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {}
    })

    const err = await replaceAssetRefsWithPublicUrls(
      [image('asset://a'), image('asset://b'), video('asset://c')],
      { lookupSourceUrl: localTable({ a: COS('a.png') }), fetchAsset, channelLabel: 'Roneyun-cn' },
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toBe(unresolvedAssetRefsMessage(['b', 'c'], 'Roneyun-cn'))
    expect(message).toContain('asset://b、asset://c')
    expect(message).not.toContain('asset://a')
    expect(message).toContain('Roneyun-cn 渠道只收公网链接')
    expect(message).toContain('火山方舟')
    expect(message).toContain('本次未提交,没有扣费')
  })

  it('没有素材库可问(自填 Key)时只靠本机绑定表,查不到就拦下', async () => {
    await expect(
      replaceAssetRefsWithPublicUrls([image('asset://only-in-cloud')], {
        lookupSourceUrl: () => null,
        channelLabel: 'Roneyun-cn',
      }),
    ).rejects.toThrow('asset://only-in-cloud')
  })

  it('素材库查询抛错按「取不到」处理,不把网络错误原样甩给用户', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchAsset = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })

    const err = await replaceAssetRefsWithPublicUrls([image('asset://img-1')], {
      lookupSourceUrl: () => null,
      fetchAsset,
      channelLabel: 'Roneyun-cn',
    }).catch((e: unknown) => e)

    expect((err as Error).message).toBe(unresolvedAssetRefsMessage(['img-1'], 'Roneyun-cn'))
    expect((err as Error).message).not.toContain('ECONNRESET')
    expect(warn).toHaveBeenCalled()
  })
})

describe('assertPublicUrlMediaOnly', () => {
  const CN = 'cn-seedance-2.0' as const

  it('只收公网链接的渠道:全是 http(s) 就放行,文本条目不看', () => {
    expect(() =>
      assertPublicUrlMediaOnly(CN, [text('asset:// 写在提示词里不算素材'), image(COS('a.png')), video('http://cdn.example.com/v.mp4')]),
    ).not.toThrow()
  })

  /**
   * 🧬 变异点:把函数体换成直接 return,这两条必红。
   */
  it('只收公网链接的渠道:漏进来一个 asset:// 就拦下并点名', () => {
    expect(() => assertPublicUrlMediaOnly(CN, [image(COS('a.png')), image('asset://leaked')])).toThrow('asset://leaked')
  })

  it('只收公网链接的渠道:漏进来 data: 也拦下,报错里不带整段 base64', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(5000)}`
    let message = ''
    try {
      assertPublicUrlMediaOnly(CN, [audio(dataUrl)])
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('data:image/png;base64,')
    expect(message.length).toBeLessThan(300)
    expect(message).toContain('本次未提交,没有扣费')
  })

  it.each(['cn-seedance-2.0', 'cn-seedance-2.0-fast', 'cn-seedance-2.0-mini', 'cn-seedance-2.5'] as const)(
    '%s 都受这道检查',
    (alias) => {
      expect(() => assertPublicUrlMediaOnly(alias, [image('asset://x')])).toThrow()
    },
  )

  /**
   * 火山认 asset:// 与内联;万相 / 可灵有各自的组包层把关。这道检查不能连带拦到它们。
   * 🧬 变异点:去掉开头按 `assetRefs` 的早退,这条必红。
   */
  it('其它渠道与缺省模型不受影响', () => {
    const content = [image('asset://x'), image('data:image/png;base64,AAAA')]
    for (const alias of ['2.0', '2.5', '2.5-flash', 'wan3', 'kling4-omni', 'depth'] as const) {
      expect(() => assertPublicUrlMediaOnly(alias, content), alias).not.toThrow()
    }
    expect(() => assertPublicUrlMediaOnly(undefined, content)).not.toThrow()
  })
})
