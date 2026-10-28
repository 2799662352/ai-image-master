import { describe, expect, it } from 'vitest'

import { KlingRequestError, buildKlingCreateBody } from '../request'
import type { SeedanceContentItem } from '../../seedance/types'
import type { KlingMultiShot } from '../../../../types/klingMultiShot'

const IMG = 'https://cos.example/a.png'

const text = (t = '一只橘猫在窗台上伸懒腰'): SeedanceContentItem => ({ type: 'text', text: t })
const first = (): SeedanceContentItem => ({ type: 'image_url', role: 'first_frame', image_url: { url: IMG } })

const customize: KlingMultiShot = {
  type: 'customize',
  shots: [
    { prompt: '猫伸懒腰', duration: 2 },
    { prompt: '猫跳下窗台', duration: 3 },
  ],
}

function build(over: Partial<Parameters<typeof buildKlingCreateBody>[0]> = {}) {
  return buildKlingCreateBody({
    model: 'kling4',
    content: [text()],
    ratio: '16:9',
    resolution: '720p',
    duration: 5,
    generateAudio: true,
    ...over,
  })
}

describe('buildKlingCreateBody · 分镜', () => {
  it('不带分镜时 metadata 里一个分镜字段都没有(网关见到 multi_shot 就要校验 shot_type / multi_prompt)', () => {
    const { metadata } = build()
    expect('multi_shot' in metadata).toBe(false)
    expect('shot_type' in metadata).toBe(false)
    expect('multi_prompt' in metadata).toBe(false)
    expect('multi_shot' in build({ multiShot: null }).metadata).toBe(false)
  })

  it('智能分镜:multi_shot + shot_type=intelligence,没有 multi_prompt(网关会拒)', () => {
    const { metadata, prompt } = build({ multiShot: { type: 'intelligence' } })
    expect(metadata.multi_shot).toBe(true)
    expect(metadata.shot_type).toBe('intelligence')
    expect('multi_prompt' in metadata).toBe(false)
    expect(prompt).toBe('一只橘猫在窗台上伸懒腰')
  })

  it('自定义分镜:逐镜头 {prompt, duration},顺序即镜头序号', () => {
    const { metadata } = build({ multiShot: customize })
    expect(metadata.multi_shot).toBe(true)
    expect(metadata.shot_type).toBe('customize')
    expect(metadata.multi_prompt).toEqual([
      { prompt: '猫伸懒腰', duration: 2 },
      { prompt: '猫跳下窗台', duration: 3 },
    ])
  })

  it('镜头描述去首尾空白,并把工作台 chip 的 【@图片1】 外壳解成 @图片1', () => {
    const { metadata } = build({
      model: 'kling4-omni',
      content: [text('总述'), { type: 'image_url', role: 'reference_image', image_url: { url: IMG } }],
      multiShot: {
        type: 'customize',
        shots: [
          { prompt: '  【@图片1】站在窗边 ', duration: 2 },
          { prompt: '收尾', duration: 3 },
        ],
      },
    })
    expect(metadata.multi_prompt?.[0].prompt).toBe('@图片1站在窗边')
  })

  it('自定义分镜且总提示词留空:顶层 prompt 与 content[0].text 都用各镜头描述拼出来的那份', () => {
    const body = build({ content: [text('')], multiShot: customize })
    const joined = '镜头1（2秒）：猫伸懒腰\n镜头2（3秒）：猫跳下窗台'
    expect(body.prompt).toBe(joined)
    expect(body.metadata.content[0]).toEqual({ type: 'text', text: joined })
  })

  it('总提示词留空时只替换那条 text,素材的顺序与角色原样保留', () => {
    const content = [text(' '), first()]
    const body = build({ content, multiShot: customize })
    expect(body.metadata.content).toHaveLength(2)
    expect(body.metadata.content[1]).toEqual(first())
  })

  it('总提示词有内容时不被各镜头描述覆盖', () => {
    expect(build({ multiShot: customize }).prompt).toBe('一只橘猫在窗台上伸懒腰')
  })

  it('智能分镜没提示词:本地拦下,不等网关回英文', () => {
    expect(() => build({ content: [text('')], multiShot: { type: 'intelligence' } })).toThrow(KlingRequestError)
    expect(() => build({ content: [text('')], multiShot: { type: 'intelligence' } })).toThrow(/智能分镜需要填写提示词/)
  })

  it('自定义分镜时长之和不等于总时长 / 镜头超过 6 个 / 描述为空:都在本地说人话', () => {
    expect(() =>
      build({ multiShot: { type: 'customize', shots: [{ prompt: 'a', duration: 2 }, { prompt: 'b', duration: 2 }] } }),
    ).toThrow(/各镜头时长之和需等于视频总时长：当前 4 秒，视频总时长 5 秒/)
    expect(() => build({ multiShot: { type: 'customize', shots: [{ prompt: ' ', duration: 5 }] } })).toThrow(
      /第 1 个镜头的描述不能为空/,
    )
    const seven = Array.from({ length: 7 }, (_, i) => ({ prompt: `镜${i}`, duration: 1 }))
    expect(() => build({ duration: 7, multiShot: { type: 'customize', shots: seven } })).toThrow(/最多 6 个镜头/)
  })

  it('分镜不改素材与时长校验:Omni 带参考图 + 分镜照常组包', () => {
    const body = build({
      model: 'kling4-omni',
      content: [text(), { type: 'image_url', role: 'reference_image', image_url: { url: IMG } }],
      multiShot: customize,
    })
    expect(body.model).toBe('kling-v4-omni-vod')
    expect(body.metadata.duration).toBe(5)
    expect(body.metadata.multi_shot).toBe(true)
  })
})
