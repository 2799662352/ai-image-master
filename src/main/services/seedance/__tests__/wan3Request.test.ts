// 万相 3.0 请求组包。协议依据:官方《万相 3.0 视频生成 API 参考》+ 网关侧
// 已验证可用的参考实现。这里全是纯函数,不打网络。

import { describe, expect, it } from 'vitest'
import {
  Wan3RequestError,
  buildWan3CreateBody,
  buildWan3ReferenceMedia,
  isAllowedWan3MediaUrl,
  mergeWan3DocumentOrLink,
  normalizeWan3Duration,
  normalizeWan3Ratio,
  normalizeWan3Resolution,
} from '../wan3Request'

const IMG = 'https://cos.example.com/a.png'
const IMG2 = 'https://cos.example.com/b.png'
const VID = 'https://cos.example.com/v.mp4'
const AUD = 'https://cos.example.com/s.mp3'

describe('isAllowedWan3MediaUrl', () => {
  it('只放行公网 http(s)', () => {
    expect(isAllowedWan3MediaUrl('https://a/b.png')).toBe(true)
    expect(isAllowedWan3MediaUrl('http://a/b.png')).toBe(true)
  })

  it('挡掉 data: / asset:// / 本地路径 / 空值', () => {
    expect(isAllowedWan3MediaUrl('data:image/png;base64,AAA')).toBe(false)
    expect(isAllowedWan3MediaUrl('asset://abc')).toBe(false)
    expect(isAllowedWan3MediaUrl('D:\\a\\b.png')).toBe(false)
    expect(isAllowedWan3MediaUrl('')).toBe(false)
    expect(isAllowedWan3MediaUrl(undefined)).toBe(false)
  })
})

// 这一组是产品硬要求:万相不认识人像库,也不要人像库兜底。
describe('绝不发人像库素材', () => {
  it('asset:// 被拦下,而且给的是人话不是「必须是 http(s)」', () => {
    expect(() =>
      buildWan3ReferenceMedia('multimodal_ref', { imageUrls: ['asset://portrait-1'] }),
    ).toThrow(/不支持人像库素材/)
  })

  it('组包结果里不可能出现 asset://', () => {
    const body = buildWan3CreateBody(
      { prompt: '一只猫', mode: 'multimodal_ref' },
      { imageUrls: [IMG], videoUrls: [VID], audioUrls: [AUD] },
    )
    const urls = body.metadata.input.media.map((m) => m.url)
    expect(urls.every((u) => u.startsWith('https://'))).toBe(true)
    expect(JSON.stringify(body)).not.toContain('asset://')
  })

  it('请求体里没有任何人像库/素材库概念的字段', () => {
    const body = buildWan3CreateBody({ prompt: '猫', mode: 'text2video' }, {})
    const json = JSON.stringify(body)
    for (const forbidden of ['assetId', 'asset_id', 'portrait', 'imageCategory']) {
      expect(json).not.toContain(forbidden)
    }
  })
})

describe('buildWan3ReferenceMedia', () => {
  it('文生视频不带任何素材', () => {
    expect(buildWan3ReferenceMedia('text2video', {})).toEqual([])
  })

  it('文生视频带了素材直接报错(而不是悄悄丢掉)', () => {
    expect(() => buildWan3ReferenceMedia('text2video', { imageUrls: [IMG] })).toThrow(
      /不携带任何素材/,
    )
  })

  it('首帧', () => {
    expect(buildWan3ReferenceMedia('first_frame', { firstFrameUrl: IMG })).toEqual([
      { type: 'first_frame', url: IMG },
    ])
  })

  it('首尾帧要两张,顺序固定', () => {
    expect(
      buildWan3ReferenceMedia('first_last_frame', { firstFrameUrl: IMG, lastFrameUrl: IMG2 }),
    ).toEqual([
      { type: 'first_frame', url: IMG },
      { type: 'last_frame', url: IMG2 },
    ])
    expect(() => buildWan3ReferenceMedia('first_last_frame', { firstFrameUrl: IMG })).toThrow(
      /首帧与尾帧/,
    )
  })

  // 官方原文:「reference_xx/file/link 类型和 first_frame/last_frame 类型互斥,
  // 不能在同一请求中混用」。混用时上游回的是
  // "The two modes are mutually exclusive. Do not pass reference_xx and
  //  first_frame/last_frame at the same time." —— 与其等这句英文回来,不如本地拦。
  it('首帧模式排斥一切 reference_xx —— 图、视频、音频都不行', () => {
    for (const extra of [
      { videoUrls: [VID] },
      { audioUrls: [AUD] },
      { imageUrls: [IMG2] },
    ]) {
      expect(() => buildWan3ReferenceMedia('first_frame', { firstFrameUrl: IMG, ...extra })).toThrow(
        /互斥|不支持/,
      )
    }
  })

  it('首尾帧模式同样排斥参考图(不能静默丢掉)', () => {
    expect(() =>
      buildWan3ReferenceMedia('first_last_frame', {
        firstFrameUrl: IMG,
        lastFrameUrl: IMG2,
        imageUrls: [IMG],
      }),
    ).toThrow(/互斥|不支持/)
  })

  it('全能参考按 图→视频→音频 排列(顺序即提示词里的编号)', () => {
    expect(
      buildWan3ReferenceMedia('multimodal_ref', {
        imageUrls: [IMG, IMG2],
        videoUrls: [VID],
        audioUrls: [AUD],
      }).map((m) => m.type),
    ).toEqual(['reference_image', 'reference_image', 'reference_video', 'reference_audio'])
  })

  it('上限 10/5/5 取自能力表', () => {
    const many = (n: number, u: string) => Array.from({ length: n }, () => u)
    expect(() =>
      buildWan3ReferenceMedia('multimodal_ref', { imageUrls: many(11, IMG) }),
    ).toThrow(/最多 10 张/)
    expect(() =>
      buildWan3ReferenceMedia('multimodal_ref', { videoUrls: many(6, VID) }),
    ).toThrow(/最多 5 段/)
  })

  it('不开放的模式直接拒(参考图 / 编辑 / 延长)', () => {
    for (const mode of ['reference_images', 'edit_video', 'extend_video'] as const) {
      expect(() => buildWan3ReferenceMedia(mode, { imageUrls: [IMG] })).toThrow(/不支持/)
    }
  })
})

describe('文档 / 网页链接', () => {
  it('追加到末尾 —— 不挤掉图/视频的编号', () => {
    const base = buildWan3ReferenceMedia('multimodal_ref', { imageUrls: [IMG], videoUrls: [VID] })
    const merged = mergeWan3DocumentOrLink(base, { type: 'file', url: 'https://x/s.pdf' }, 'multimodal_ref')
    expect(merged.map((m) => m.type)).toEqual(['reference_image', 'reference_video', 'file'])
  })

  it('displayName 不上行', () => {
    const merged = mergeWan3DocumentOrLink(
      [],
      { type: 'link', url: 'https://news/a', displayName: '某篇报道' },
      'multimodal_ref',
    )
    expect(merged).toEqual([{ type: 'link', url: 'https://news/a' }])
  })

  it('与首帧 / 首尾帧互斥(官方约束)', () => {
    for (const mode of ['first_frame', 'first_last_frame'] as const) {
      expect(() =>
        mergeWan3DocumentOrLink([], { type: 'file', url: 'https://x/s.pdf' }, mode),
      ).toThrow(/不能同时使用文档或网页链接/)
    }
  })

  it('没有文档时原样返回', () => {
    expect(mergeWan3DocumentOrLink([{ type: 'reference_image', url: IMG }], null, 'multimodal_ref'))
      .toEqual([{ type: 'reference_image', url: IMG }])
  })
})

describe('参数归一', () => {
  it('时长:-1 放行,2–30 整数放行,其余拒', () => {
    expect(normalizeWan3Duration(-1)).toBe(-1)
    expect(normalizeWan3Duration(2)).toBe(2)
    expect(normalizeWan3Duration(30)).toBe(30)
    expect(normalizeWan3Duration(undefined)).toBeUndefined()
    expect(() => normalizeWan3Duration(1)).toThrow(Wan3RequestError)
    expect(() => normalizeWan3Duration(31)).toThrow(Wan3RequestError)
    expect(() => normalizeWan3Duration(5.5)).toThrow(Wan3RequestError)
  })

  it('分辨率:内部小写进、官方大写出', () => {
    expect(normalizeWan3Resolution('720p')).toBe('720P')
    expect(normalizeWan3Resolution('1080P')).toBe('1080P')
    expect(normalizeWan3Resolution(undefined)).toBeUndefined()
    // 4k 是 Seedance 2.0 的档位,万相没有。
    expect(() => normalizeWan3Resolution('4k')).toThrow(/仅支持/)
  })

  it('画幅白名单,含 adaptive', () => {
    expect(normalizeWan3Ratio('adaptive')).toBe('adaptive')
    expect(normalizeWan3Ratio('9:16')).toBe('9:16')
    expect(() => normalizeWan3Ratio('21:9')).toThrow(/不支持画幅/)
  })
})

describe('buildWan3CreateBody', () => {
  it('文生视频的最小请求体', () => {
    const body = buildWan3CreateBody(
      { prompt: '  一只橘猫在窗台晒太阳  ', mode: 'text2video', resolution: '720p', duration: 5 },
      {},
    )
    expect(body.model).toBe('wan3.0-video')
    expect(body.prompt).toBe('一只橘猫在窗台晒太阳')
    expect(body.seconds).toBe('5')
    expect(body.size).toBe('720P')
    expect(body.metadata.input.media).toEqual([])
    expect(body.metadata.parameters).toMatchObject({
      prompt_extend: true,
      audio: true,
      resolution: '720P',
      duration: 5,
    })
  })

  it('media 在 input.media 与 media 两处同内容 —— 跟着已验证可用的实现走', () => {
    const body = buildWan3CreateBody({ prompt: '猫', mode: 'first_frame' }, { firstFrameUrl: IMG })
    expect(body.metadata.media).toEqual(body.metadata.input.media)
    expect(body.metadata.media).toEqual([{ type: 'first_frame', url: IMG }])
  })

  it('智能时长 -1 一路带到底(顶层与 parameters 都要有)', () => {
    const body = buildWan3CreateBody({ prompt: '猫', mode: 'text2video', duration: -1 }, {})
    expect(body.seconds).toBe('-1')
    expect(body.metadata.parameters.duration).toBe(-1)
  })

  it('没给的参数字段完全不出现,不填默认值蒙混', () => {
    const body = buildWan3CreateBody({ prompt: '猫', mode: 'text2video' }, {})
    expect(Object.hasOwn(body, 'seconds')).toBe(false)
    expect(Object.hasOwn(body, 'size')).toBe(false)
    expect(Object.hasOwn(body.metadata.parameters, 'ratio')).toBe(false)
    expect(Object.hasOwn(body.metadata.parameters, 'duration')).toBe(false)
  })

  it('官方默认有声,显式关掉才是 false', () => {
    expect(buildWan3CreateBody({ prompt: '猫', mode: 'text2video' }, {}).metadata.parameters.audio).toBe(true)
    expect(
      buildWan3CreateBody({ prompt: '猫', mode: 'text2video', generateAudio: false }, {})
        .metadata.parameters.audio,
    ).toBe(false)
  })

  it('空提示词直接拒', () => {
    expect(() => buildWan3CreateBody({ prompt: '   ', mode: 'text2video' }, {})).toThrow(/提示词/)
  })

  it('全能参考 + 文档的完整形态', () => {
    const body = buildWan3CreateBody(
      {
        prompt: '参考【图片1】的角色，用【视频1】的运镜',
        mode: 'multimodal_ref',
        resolution: '1080p',
        ratio: '16:9',
        duration: -1,
        documentOrLink: { type: 'file', url: 'https://x/shots.pdf', displayName: '分镜.pdf' },
      },
      { imageUrls: [IMG], videoUrls: [VID], audioUrls: [AUD] },
    )
    expect(body.metadata.input.media).toEqual([
      { type: 'reference_image', url: IMG },
      { type: 'reference_video', url: VID },
      { type: 'reference_audio', url: AUD },
      { type: 'file', url: 'https://x/shots.pdf' },
    ])
    expect(body.metadata.parameters).toMatchObject({ resolution: '1080P', ratio: '16:9', duration: -1 })
  })
})
