// 经 Miau 网关提交 Seedance 的请求组包。纯函数,不打网络。
//
// 这一组里有三条**变异测试**（`role` 位置 / URL 键名 / 顺序即编号）。它们断言的
// 不是「组包对不对」而是「`content[]` 有没有被动过」—— 三条都属于「上游照单全收、
// 生成结果却不是用户要的」那一类,任何一条被破坏时唯一的信号就是这三个用例。

import { describe, expect, it } from 'vitest'
import {
  SEEDANCE_GATEWAY_DEFAULTS,
  buildSeedanceGatewayCreateBody,
} from '../request'
import type { SeedanceContentItem } from '../../seedance/types'

const IMG = 'https://cos.example.com/face.png'
const IMG2 = 'https://cos.example.com/scene.png'
const VID = 'https://cos.example.com/clip.mp4'
const AUD = 'https://cos.example.com/voice.mp3'

/** 与 `seedance/runtime.ts` 的 `buildContent()` 产出同形：text 在首,其余按输入次序。 */
function content(): SeedanceContentItem[] {
  return [
    { type: 'text', text: '一只猫在屋顶上跳跃' },
    { type: 'image_url', role: 'first_frame', image_url: { url: IMG } },
    { type: 'image_url', role: 'reference_image', image_url: { url: IMG2 } },
    { type: 'video_url', role: 'reference_video', video_url: { url: VID } },
    { type: 'audio_url', role: 'reference_audio', audio_url: { url: AUD } },
  ]
}

describe('buildSeedanceGatewayCreateBody 信封', () => {
  it('五个参数都在 metadata 里,不在顶层', () => {
    const body = buildSeedanceGatewayCreateBody({
      model: 'doubao-seedance-2-0-260128',
      content: content(),
      duration: 10,
      ratio: '9:16',
      resolution: '1080p',
      generateAudio: false,
    })

    expect(body.metadata).toEqual({
      content: content(),
      duration: 10,
      ratio: '9:16',
      resolution: '1080p',
      generate_audio: false,
    })
    // vvdance 直连是扁平 body,网关要 metadata 包裹 —— 漏掉包裹上游会静默按默认值跑。
    for (const flat of ['duration', 'ratio', 'resolution', 'generate_audio', 'content']) {
      expect(body).not.toHaveProperty(flat)
    }
  })

  it('顶层 prompt 与 content[0].text 逐字相同（刻意重复的那一份）', () => {
    const body = buildSeedanceGatewayCreateBody({
      model: 'doubao-seedance-2-0-260128',
      content: content(),
    })
    expect(body.prompt).toBe('一只猫在屋顶上跳跃')
    expect(body.metadata.content[0]).toEqual({ type: 'text', text: '一只猫在屋顶上跳跃' })
  })

  it('content 里没有 text 条目时才用 promptFallback 兜底', () => {
    const body = buildSeedanceGatewayCreateBody({
      model: 'm',
      content: [{ type: 'image_url', role: 'first_frame', image_url: { url: IMG } }],
      promptFallback: '兜底提示词',
    })
    expect(body.prompt).toBe('兜底提示词')
  })

  it('有 text 条目时 promptFallback 不参与 —— 顶层那份必须是真正会发出去的提示词', () => {
    const body = buildSeedanceGatewayCreateBody({
      model: 'm',
      content: content(),
      promptFallback: '归一化之前的原始输入',
    })
    expect(body.prompt).toBe('一只猫在屋顶上跳跃')
  })

  it('model 原样透传,不做任何前缀改写', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'doubao-seedance-2-5-260628', content: content() })
    expect(body.model).toBe('doubao-seedance-2-5-260628')
  })
})

describe('默认值跟随桌面端现状', () => {
  it('ratio 默认 16:9（不是参考实现的 9:16）', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content() })
    expect(body.metadata.ratio).toBe('16:9')
    expect(SEEDANCE_GATEWAY_DEFAULTS.ratio).toBe('16:9')
  })

  it('resolution / duration / generate_audio 的默认值', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content() })
    expect(body.metadata.resolution).toBe('720p')
    expect(body.metadata.duration).toBe(5)
    expect(body.metadata.generate_audio).toBe(true)
  })

  it('generateAudio 显式传 false 不被默认值吃掉', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content(), generateAudio: false })
    expect(body.metadata.generate_audio).toBe(false)
  })

  it('智能时长 -1 原样透传（不被当成非法值兜回默认）', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content(), duration: -1 })
    expect(body.metadata.duration).toBe(-1)
  })
})

// ── 三条不变量 ──────────────────────────────────────────────────────────────

describe('不变量 1：role 在 entry 顶层', () => {
  it('role 是 entry 自己的键,持 URL 的对象里只有 url', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content() })
    const entries = body.metadata.content.slice(1) as Array<Record<string, unknown>>

    for (const entry of entries) {
      expect(typeof entry.role).toBe('string')
      const urlKey = String(entry.type)
      // 嵌进 url 对象里 schema 照样接受,模型却忽略 —— 首帧静默降级成松散参考。
      expect(Object.keys(entry[urlKey] as object)).toEqual(['url'])
    }
  })

  it('首帧的 role 是 first_frame 而不是被抹平成 reference_image', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content() })
    expect(body.metadata.content[1]).toEqual({
      type: 'image_url',
      role: 'first_frame',
      image_url: { url: IMG },
    })
  })
})

describe('不变量 2：持 URL 的键名跟 type 走', () => {
  it('三种 type 各用各的键,不合并成通用 url', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content() })
    const byType = new Map(
      (body.metadata.content as Array<Record<string, unknown>>).map((e) => [String(e.type), e]),
    )

    expect(byType.get('image_url')).toHaveProperty('image_url')
    expect(byType.get('image_url')).not.toHaveProperty('video_url')
    expect(byType.get('image_url')).not.toHaveProperty('url')

    expect(byType.get('video_url')).toHaveProperty('video_url')
    expect(byType.get('video_url')).not.toHaveProperty('image_url')

    expect(byType.get('audio_url')).toHaveProperty('audio_url')
    expect(byType.get('audio_url')).not.toHaveProperty('image_url')
  })
})

describe('不变量 3：顺序即编号', () => {
  it('多张图按输入次序排列 —— 提示词里的「图片1/图片2」按下标解析', () => {
    const many: SeedanceContentItem[] = [
      { type: 'text', text: '图片1 是脸,图片2 是场景' },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'https://x/1.png' } },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'https://x/2.png' } },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'https://x/3.png' } },
    ]
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: many })

    expect(
      (body.metadata.content as Array<Record<string, { url?: string }>>)
        .slice(1)
        .map((e) => e.image_url?.url),
    ).toEqual(['https://x/1.png', 'https://x/2.png', 'https://x/3.png'])
  })

  it('混排的素材不按 type 分组重排', () => {
    const interleaved: SeedanceContentItem[] = [
      { type: 'text', text: 't' },
      { type: 'video_url', role: 'reference_video', video_url: { url: VID } },
      { type: 'image_url', role: 'reference_image', image_url: { url: IMG } },
      { type: 'audio_url', role: 'reference_audio', audio_url: { url: AUD } },
      { type: 'image_url', role: 'reference_image', image_url: { url: IMG2 } },
    ]
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: interleaved })

    expect(body.metadata.content.map((e) => e.type)).toEqual([
      'text',
      'video_url',
      'image_url',
      'audio_url',
      'image_url',
    ])
  })
})

describe('content[] 直通', () => {
  it('逐字节等于传入的数组（不重组、不补字段、不丢字段）', () => {
    const input = content()
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: input })
    expect(body.metadata.content).toEqual(input)
    expect(JSON.stringify(body.metadata.content)).toBe(JSON.stringify(input))
  })

  it('asset:// 放行 —— 平台人像库引用正是这条路存在的理由', () => {
    const withAsset: SeedanceContentItem[] = [
      { type: 'text', text: '主角出场' },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'asset://portrait-42' } },
    ]
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: withAsset })
    expect(JSON.stringify(body)).toContain('asset://portrait-42')
  })

  it('assetId 等上游认识的附加字段也一并带过去', () => {
    const withAssetId: SeedanceContentItem[] = [
      { type: 'text', text: 't' },
      {
        type: 'image_url',
        role: 'reference_image',
        image_url: { url: 'asset://p-1' },
        assetId: 'p-1',
      },
    ]
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: withAssetId })
    expect(body.metadata.content[1]).toHaveProperty('assetId', 'p-1')
  })
})

describe('vvdance 专属字段不外泄', () => {
  it('信封里没有 seed / tools / taskMode —— 网关侧没有对等物', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content() })
    const json = JSON.stringify(body)
    for (const forbidden of ['seed', 'tools', 'taskMode', 'web_search']) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('顶层只有 model / prompt / metadata 三个键', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content: content() })
    expect(Object.keys(body).sort()).toEqual(['metadata', 'model', 'prompt'])
  })
})
