// content[] → 万相的素材槽。
//
// 为什么复用 content[] 而不是让万相自己再解析一遍素材:那一步(本地文件读取、
// COS 中转、asset:// 展开、alwaysRelay)全在 buildContent 里,再写一遍就是第二份
// 会各自漂移的实现。content[] 名字带 Seedance,实际上是我们内部「已解析素材」的
// 通用表示,role 与万相的槽位一一对应。

import { describe, expect, it } from 'vitest'
import { resolveVideoMode, toWan3ResolvedMedia } from '../fromContent'
import type { SeedanceContentItem } from '../../seedance/types'

const IMG = 'https://cos.example/a.png'
const IMG2 = 'https://cos.example/b.png'
const VID = 'https://cos.example/v.mp4'
const AUD = 'https://cos.example/a.mp3'

function img(url: string, role: 'first_frame' | 'last_frame' | 'reference_image'): SeedanceContentItem {
  return { type: 'image_url', role, image_url: { url } }
}

describe('toWan3ResolvedMedia', () => {
  it('text 条目不是素材,被跳过', () => {
    expect(toWan3ResolvedMedia([{ type: 'text', text: '一只猫' }])).toEqual({
      imageUrls: [],
      videoUrls: [],
      audioUrls: [],
    })
  })

  it('按 role 分槽', () => {
    const content: SeedanceContentItem[] = [
      { type: 'text', text: '猫' },
      img(IMG, 'first_frame'),
      img(IMG2, 'last_frame'),
    ]
    const r = toWan3ResolvedMedia(content)
    expect(r.firstFrameUrl).toBe(IMG)
    expect(r.lastFrameUrl).toBe(IMG2)
    expect(r.imageUrls).toEqual([])
  })

  it('参考图 / 视频 / 音频各自成组', () => {
    const content: SeedanceContentItem[] = [
      { type: 'text', text: '猫' },
      img(IMG, 'reference_image'),
      img(IMG2, 'reference_image'),
      { type: 'video_url', role: 'reference_video', video_url: { url: VID } },
      { type: 'audio_url', role: 'reference_audio', audio_url: { url: AUD } },
    ]
    const r = toWan3ResolvedMedia(content)
    expect(r.imageUrls).toEqual([IMG, IMG2])
    expect(r.videoUrls).toEqual([VID])
    expect(r.audioUrls).toEqual([AUD])
  })

  it('保持输入顺序 —— 提示词里的「图片1」指的是第几张,顺序错了不报错但出错片', () => {
    // 与 buildContent 的顺序不变量同源(见 buildContent.order.test.ts)。
    const urls = ['https://c/1.png', 'https://c/2.png', 'https://c/3.png']
    const content: SeedanceContentItem[] = urls.map((u) => img(u, 'reference_image'))
    expect(toWan3ResolvedMedia(content).imageUrls).toEqual(urls)
  })

  it('没有 role 的图片按参考图处理 —— 与 Seedance 的默认语义一致', () => {
    const content: SeedanceContentItem[] = [{ type: 'image_url', image_url: { url: IMG } }]
    expect(toWan3ResolvedMedia(content).imageUrls).toEqual([IMG])
  })

  it('空 content 得到空的三个数组,而不是 undefined', () => {
    // buildWan3ReferenceMedia 会读 .length,给 undefined 就得在那边到处补 ?? []。
    const r = toWan3ResolvedMedia([])
    expect(r.imageUrls).toEqual([])
    expect(r.videoUrls).toEqual([])
    expect(r.audioUrls).toEqual([])
    expect(r.firstFrameUrl).toBeUndefined()
  })

  it('非 https 的素材原样带过 —— 由组包层统一拒,错误话术只此一处', () => {
    // 这里悄悄丢掉的话,用户会看到「首帧模式需要一张首帧图」这种驴唇不对马嘴的
    // 提示,而真实原因是那张图还是本地路径。requireHttpUrl 才是说人话的地方。
    const content: SeedanceContentItem[] = [img('C:/local/a.png', 'first_frame')]
    expect(toWan3ResolvedMedia(content).firstFrameUrl).toBe('C:/local/a.png')
  })
})

describe('resolveVideoMode', () => {
  const empty = { imageUrls: [], videoUrls: [], audioUrls: [] }

  it('显式模式优先 —— 工作台一律显式带,不能被素材形状推翻', () => {
    // 关键:带着参考视频的 extend_video 若被反推,会变成 multimodal_ref,
    // 也就是「用户选了延长视频,发出去的是一次普通生成」,且不报任何错。
    expect(resolveVideoMode('extend_video', { ...empty, videoUrls: ['https://c/v.mp4'] })).toBe('extend_video')
    expect(resolveVideoMode('text2video', { ...empty, imageUrls: ['https://c/a.png'] })).toBe('text2video')
  })

  it('缺省时按素材形状兜底 —— 给 MCP agent 那条没有模式概念的路', () => {
    expect(resolveVideoMode(undefined, empty)).toBe('text2video')
    expect(resolveVideoMode(undefined, { ...empty, firstFrameUrl: 'https://c/a.png' })).toBe('first_frame')
    expect(
      resolveVideoMode(undefined, { ...empty, firstFrameUrl: 'https://c/a.png', lastFrameUrl: 'https://c/b.png' }),
    ).toBe('first_last_frame')
    expect(resolveVideoMode(undefined, { ...empty, imageUrls: ['https://c/a.png'] })).toBe('multimodal_ref')
    expect(resolveVideoMode(undefined, { ...empty, audioUrls: ['https://c/a.mp3'] })).toBe('multimodal_ref')
  })

  it('只有尾帧没有首帧时不谎报 first_last_frame', () => {
    // 组包层会因为「首帧模式需要一张首帧图」而拒,那句话是对的;
    // 反推成 first_last_frame 则会让它去抱怨尾帧,指错方向。
    expect(resolveVideoMode(undefined, { ...empty, lastFrameUrl: 'https://c/b.png' })).toBe('multimodal_ref')
  })
})
