import { describe, expect, it } from 'vitest'
import { normalizeSeedancePromptReferences } from '../promptReferences'

// 提示词原样发送:`@图片1` 是官方 OpenAPI 的写法,`@` 不删;排版不动;别名不翻译。
// 运行时唯一动的是工作台 chip 的 `【@图片N】` 外壳。
describe('normalizeSeedancePromptReferences', () => {
  it('keeps @图片N / @视频N / @音频N exactly as written', () => {
    const prompt = '@图片1 中的女子参考 @视频2 的运镜，音色沿用 @音频3；联系 @director。'
    expect(normalizeSeedancePromptReferences(prompt)).toBe(prompt)
  })

  it('unwraps workbench chip tokens 【@图片N】 to @图片N and nothing else', () => {
    expect(
      normalizeSeedancePromptReferences('【@图片1】参考灯光；【@视频2】延长；【@音频1】淡出。'),
    ).toBe('@图片1参考灯光；@视频2延长；@音频1淡出。')
  })

  it('leaves subtitle markers, sound markers, and dialogue braces alone', () => {
    const prompt = '【第一章：启程】<远处传来钟声>（背景播放钢琴乐）{我知道了。}'
    expect(normalizeSeedancePromptReferences(prompt)).toBe(prompt)
  })

  it('does not translate foreign aliases or legacy angle-bracket forms', () => {
    const prompt = '@Image1 follows @Video2; <图片3> 参考构图；图片4 也照写。'
    expect(normalizeSeedancePromptReferences(prompt)).toBe(prompt)
  })

  it('does not reflow layout: blank lines and spaces are sent as written', () => {
    const prompt = '【生成目标】\n\n生成一段视频。  \n\n开始时： 木椅位于桌面。\n'
    expect(normalizeSeedancePromptReferences(prompt)).toBe(prompt)
  })
})
