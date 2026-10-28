import { describe, expect, it } from 'vitest'

import { asKlingAlias, klingUpstreamModelId } from '../model'
import { KlingRequestError, buildKlingCreateBody } from '../request'
import type { SeedanceContentItem } from '../../seedance/types'

const IMG = 'https://cos.example/a.png'
const IMG2 = 'https://cos.example/b.png'
const VID = 'https://cos.example/v.mp4'

const text = (t = '一只橘猫在窗台上伸懒腰'): SeedanceContentItem => ({ type: 'text', text: t })
const first = (url = IMG): SeedanceContentItem => ({ type: 'image_url', role: 'first_frame', image_url: { url } })
const last = (url = IMG2): SeedanceContentItem => ({ type: 'image_url', role: 'last_frame', image_url: { url } })
const refImg = (url = IMG): SeedanceContentItem => ({ type: 'image_url', role: 'reference_image', image_url: { url } })
const refVid = (url = VID): SeedanceContentItem => ({ type: 'video_url', role: 'reference_video', video_url: { url } })
const refAud = (url = 'https://cos.example/a.mp3'): SeedanceContentItem => ({
  type: 'audio_url',
  role: 'reference_audio',
  audio_url: { url },
})

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

describe('可灵上游模型 id', () => {
  it('两档各用各的 slug —— 它同时决定网关放不放参考素材', () => {
    expect(klingUpstreamModelId('kling4')).toBe('kling-v4-vod')
    expect(klingUpstreamModelId('kling4-omni')).toBe('kling-v4-omni-vod')
  })

  it('非可灵别名直接抛,不兜底成 kling4(兜底 = 跑着别人的模型按可灵价扣费)', () => {
    expect(() => asKlingAlias('wan3')).toThrow(/非可灵/)
    expect(() => asKlingAlias(undefined)).toThrow(/非可灵/)
    expect(asKlingAlias('kling4-omni')).toBe('kling4-omni')
  })
})

describe('buildKlingCreateBody · 信封', () => {
  it('网关信封:metadata 包裹 + 与 content[0].text 相同的顶层 prompt', () => {
    const body = build()
    expect(body.model).toBe('kling-v4-vod')
    expect(body.prompt).toBe('一只橘猫在窗台上伸懒腰')
    expect(body.metadata).toEqual({
      content: [text()],
      duration: 5,
      ratio: '16:9',
      resolution: '720p',
      generate_audio: true,
    })
  })

  it('分辨率小写透传(2k / 4k 网关大小写不敏感,内部口径统一小写)', () => {
    expect(build({ resolution: '2K' }).metadata.resolution).toBe('2k')
    expect(build({ resolution: '4k' }).metadata.resolution).toBe('4k')
  })

  it('adaptive 画幅原样透传(网关据此「不指定」,交给模型自适应)', () => {
    expect(build({ ratio: 'adaptive' }).metadata.ratio).toBe('adaptive')
  })

  it('generate_audio 关掉时必须显式发 false,不能因为是假值就省略', () => {
    expect(build({ generateAudio: false }).metadata.generate_audio).toBe(false)
  })

  it('素材顺序与角色原样保留 —— 提示词里的「图片N」按 content[] 下标解析', () => {
    const content = [text(), first(), last()]
    expect(build({ content }).metadata.content).toEqual(content)
  })
})

describe('buildKlingCreateBody · 本地先拦网关必拒的组合', () => {
  it('时长必须是 3–30 的整数,-1(智能时长)可灵没有', () => {
    for (const duration of [-1, 2, 31, 4.5]) {
      expect(() => build({ duration }), String(duration)).toThrow(KlingRequestError)
    }
    expect(build({ duration: 3 }).metadata.duration).toBe(3)
    expect(build({ duration: 30 }).metadata.duration).toBe(30)
  })

  it('画幅只认 21:9 / 16:9 / 9:16 / 1:1 / adaptive(没有 4:3)', () => {
    expect(() => build({ ratio: '4:3' })).toThrow(/画幅/)
    expect(() => build({ ratio: '3:4' })).toThrow(/画幅/)
    for (const ratio of ['21:9', '16:9', '9:16', '1:1', 'adaptive']) {
      expect(build({ ratio }).metadata.ratio).toBe(ratio)
    }
  })

  it('分辨率不在 720p / 1080p / 2k / 4k 内就拒(480p 是 Seedance 的档)', () => {
    expect(() => build({ resolution: '480p' })).toThrow(/分辨率/)
  })

  it('参考音频一律拒:可灵没有音频参考', () => {
    expect(() => build({ model: 'kling4-omni', content: [text(), first(), refAud()] })).toThrow(/音频/)
  })

  it('素材必须是公网 http(s) 直链;asset:// 单独给一句人话', () => {
    expect(() => build({ content: [text(), first('asset://abc')] })).toThrow(/人像库|素材库/)
    expect(() => build({ content: [text(), first('file:///C:/a.png')] })).toThrow(/http/)
    expect(() => build({ content: [text(), first('data:image/png;base64,AAAA')] })).toThrow(/http/)
  })

  it('素材地址超过 8182 字符网关会拒,本地先说清楚', () => {
    const long = `https://cos.example/${'a'.repeat(8200)}.png`
    expect(() => build({ content: [text(), first(long)] })).toThrow(/8182|过长/)
  })

  it('尾帧必须配首帧', () => {
    expect(() => build({ content: [text(), last()] })).toThrow(/首帧/)
  })

  it('首帧 / 尾帧各至多一张', () => {
    expect(() => build({ content: [text(), first(), first(IMG2)] })).toThrow(/首帧/)
    expect(() => build({ content: [text(), first(), last(), last(IMG)] })).toThrow(/尾帧/)
  })

  it('没有任何素材时提示词不能为空(网关:无文件必须有 prompt)', () => {
    expect(() => build({ content: [text('   ')] })).toThrow(/提示词/)
    // 有首帧时提示词可以为空
    expect(() => build({ content: [text(''), first()] })).not.toThrow()
  })
})

describe('buildKlingCreateBody · 4.0 与 Omni 的素材边界', () => {
  it('4.0 不收参考图 / 参考视频 —— 指路 Omni,而不是让网关回一句 400', () => {
    expect(() => build({ model: 'kling4', content: [text(), refImg()] })).toThrow(/Omni/)
    expect(() => build({ model: 'kling4', content: [text(), refVid()] })).toThrow(/Omni/)
  })

  it('4.0 的首帧 / 首尾帧照常放行', () => {
    expect(() => build({ model: 'kling4', content: [text(), first(), last()] })).not.toThrow()
  })

  it('Omni 收参考图与参考视频,首尾帧也收', () => {
    const content = [text(), first(), last(), refImg(), refVid()]
    expect(build({ model: 'kling4-omni', content }).metadata.content).toEqual(content)
    expect(build({ model: 'kling4-omni', content }).model).toBe('kling-v4-omni-vod')
  })

  it('Omni 参考图 ≤ 10、参考视频 ≤ 5、合计 ≤ 15', () => {
    const imgs = (n: number) => Array.from({ length: n }, (_, i) => refImg(`https://cos.example/i${i}.png`))
    const vids = (n: number) => Array.from({ length: n }, (_, i) => refVid(`https://cos.example/v${i}.mp4`))
    expect(() => build({ model: 'kling4-omni', content: [text(), ...imgs(10)] })).not.toThrow()
    expect(() => build({ model: 'kling4-omni', content: [text(), ...imgs(11)] })).toThrow(/参考图/)
    expect(() => build({ model: 'kling4-omni', content: [text(), ...imgs(1), ...vids(5)] })).not.toThrow()
    expect(() => build({ model: 'kling4-omni', content: [text(), ...imgs(1), ...vids(6)] })).toThrow(/参考视频/)
    // 10 + 5 = 15 刚好;首帧 / 尾帧也算文件 → 17 超
    expect(() => build({ model: 'kling4-omni', content: [text(), ...imgs(10), ...vids(5)] })).not.toThrow()
    expect(() =>
      build({ model: 'kling4-omni', content: [text(), first(), last(), ...imgs(10), ...vids(5)] }),
    ).toThrow(/15/)
  })
})
