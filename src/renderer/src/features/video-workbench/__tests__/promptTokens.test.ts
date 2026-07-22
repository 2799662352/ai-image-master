// 提示词素材 token 工具单测(@ 检测 / token 插入 / 删除素材序号重排)。

import { describe, expect, it } from 'vitest'
import {
  applyTokenAtCursor,
  detectAtTrigger,
  mediaToken,
  parseTokenZh,
  removeTokenAndReindex,
} from '../promptTokens'

describe('mediaToken / parseTokenZh', () => {
  it('生成规范 token 并互转', () => {
    expect(mediaToken('image', 1)).toBe('【@图片1】')
    expect(mediaToken('video', 3)).toBe('【@视频3】')
    expect(mediaToken('audio', 2)).toBe('【@音频2】')
    expect(parseTokenZh('图片')).toBe('image')
    expect(parseTokenZh('视频')).toBe('video')
    expect(parseTokenZh('音频')).toBe('audio')
  })
})

describe('detectAtTrigger(soraui 光标回溯语义)', () => {
  it('行首 @ 触发', () => {
    const det = detectAtTrigger('@图', 2)
    expect(det).toMatchObject({ atPosition: 0, prefix: '@图', shouldShow: true })
  })

  it('空白后的 @ 触发;紧贴文字的 @ 不触发(位置非法)', () => {
    expect(detectAtTrigger('一只猫 @图', 6)?.shouldShow).toBe(true)
    expect(detectAtTrigger('一只猫@图', 5)?.shouldShow).toBe(false)
  })

  it('遇到分隔符停止回溯(@ 不在当前词内=null)', () => {
    expect(detectAtTrigger('@图片 之后', 6)).toBeNull()
    expect(detectAtTrigger('没有at符号', 5)).toBeNull()
  })

  it('token 右括号】后的 @ 触发', () => {
    const text = '【@图片1】@视'
    const det = detectAtTrigger(text, text.length)
    expect(det?.shouldShow).toBe(true)
  })
})

describe('applyTokenAtCursor', () => {
  it('替换 @前缀 为 token 并补前后空格', () => {
    const { text, cursor } = applyTokenAtCursor('一只猫@图', 5, '【@图片1】')
    expect(text).toBe('一只猫 【@图片1】 ')
    expect(cursor).toBe(text.length)
  })

  it('后文已有空白时不重复补空格', () => {
    const { text } = applyTokenAtCursor('@图 走路', 2, '【@图片1】')
    expect(text).toBe('【@图片1】 走路')
  })

  it('找不到 @ 时原样返回', () => {
    const { text, cursor } = applyTokenAtCursor('无符号', 3, '【@图片1】')
    expect(text).toBe('无符号')
    expect(cursor).toBe(3)
  })
})

describe('removeTokenAndReindex(soraui removeMedia 语义)', () => {
  it('删除 token 并把同类后续序号 -1', () => {
    const prompt = '【@图片1】和【@图片2】还有【@图片3】'
    expect(removeTokenAndReindex(prompt, 'image', 2)).toBe('【@图片1】和还有【@图片2】')
  })

  it('占位符法避免连环替换(3→2 不再被 2→1 二次污染)', () => {
    const prompt = '【@图片2】【@图片3】【@图片4】'
    expect(removeTokenAndReindex(prompt, 'image', 1)).toBe('【@图片1】【@图片2】【@图片3】')
  })

  it('不影响其他类型 token', () => {
    const prompt = '【@图片1】【@视频1】【@视频2】'
    expect(removeTokenAndReindex(prompt, 'video', 1)).toBe('【@图片1】【@视频1】')
  })

  it('prompt 中无该 token 时只做序号重排(幂等)', () => {
    expect(removeTokenAndReindex('纯文本', 'image', 1)).toBe('纯文本')
  })
})
