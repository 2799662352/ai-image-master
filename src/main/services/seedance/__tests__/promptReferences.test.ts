import { describe, expect, it } from 'vitest'
import { normalizeSeedancePromptReferences } from '../promptReferences'

describe('normalizeSeedancePromptReferences', () => {
  it('normalizes Fal, Chinese-at, editor, and legacy aliases to app ordinals', () => {
    expect(
      normalizeSeedancePromptReferences(
        '@Image1 follows @Video2; voice @Audio3; 【@图片4】参考灯光；<视频5>延长；@音频6 淡出。',
      ),
    ).toBe('图片1 follows 视频2; voice 音频3; 图片4参考灯光；视频5延长；音频6 淡出。')
  })

  it('preserves already canonical ordinals and non-reference at mentions', () => {
    expect(
      normalizeSeedancePromptReferences(
        '图片1 锁身份，视频2 锁运镜，音频3 锁音色；联系 @director，不改 imageboard。',
      ),
    ).toBe('图片1 锁身份，视频2 锁运镜，音频3 锁音色；联系 @director，不改 imageboard。')
  })

  it('does not rewrite non-numeric placeholders used in documentation drafts', () => {
    expect(normalizeSeedancePromptReferences('@图片N / @ImageN / <图片N>')).toBe(
      '@图片N / @ImageN / <图片N>',
    )
  })
})
