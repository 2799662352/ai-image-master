import { describe, expect, it } from 'vitest'
import { cardSummaryState, promptFingerprint } from '../cardSummary'

/**
 * 卡片摘要的新鲜度判定。这层存在的全部意义是**过期摘要永远不会被当成当前状态展示** ——
 * 提示词天天变(patch_prompt 存在的理由),而一条过期摘要比截断更危险:截断看得出
 * 残缺,过期摘要看起来是权威的。
 */

describe('promptFingerprint', () => {
  it('同样的提示词给同样的指纹', () => {
    expect(promptFingerprint('镜头 dolly in 推进')).toBe(promptFingerprint('镜头 dolly in 推进'))
  })

  it('改一个字就变', () => {
    expect(promptFingerprint('镜头 dolly in 推进')).not.toBe(promptFingerprint('镜头 rack focus 推进'))
  })

  // 我们的提示词是 sd2-pe 工程化过的，开头几十字结构固定 —— 指纹必须看全文，
  // 否则同一页的卡会大面积撞在一起。
  it('只有结尾不同也能区分', () => {
    const head = '中景，35mm，侧逆光，夜景霓虹，手持轻微晃动，'
    expect(promptFingerprint(`${head}主角跳上车顶`)).not.toBe(promptFingerprint(`${head}主角滚落台阶`))
  })

  it('空提示词也有稳定指纹', () => {
    expect(promptFingerprint('')).toBe(promptFingerprint(''))
  })
})

describe('cardSummaryState', () => {
  const prompt = '镜头 dolly in 推进'

  it('没写过 = absent', () => {
    expect(cardSummaryState({ prompt })).toBe('absent')
  })

  it('指纹对得上 = fresh', () => {
    expect(cardSummaryState({ prompt, summary: '追车第3镜', summaryFor: promptFingerprint(prompt) }))
      .toBe('fresh')
  })

  it('提示词改过 = stale', () => {
    const stamped = promptFingerprint(prompt)
    expect(cardSummaryState({ prompt: '镜头 rack focus 推进', summary: '追车第3镜', summaryFor: stamped }))
      .toBe('stale')
  })

  // 老卡片没有 summaryFor 字段：有摘要但无从判断新鲜度，一律当过期处理。
  // 「不确定」必须落在安全的那一边。
  it('缺 summaryFor 时按过期处理', () => {
    expect(cardSummaryState({ prompt, summary: '追车第3镜' })).toBe('stale')
  })
})
