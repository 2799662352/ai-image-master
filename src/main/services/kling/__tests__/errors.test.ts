import { describe, expect, it } from 'vitest'

import { translateVideoTaskError } from '../../videoTaskError'
import { translateKlingError } from '../errors'

describe('translateKlingError', () => {
  it('账号并发满(网关实测:FINISH + ErrCode 70000):说清是并发、已退款、该怎么办', () => {
    const raw = 'GenerateVideo task reached the maximum concurrency. (ErrCode 70000)'
    const out = translateKlingError(raw)
    expect(out).toMatch(/并发/)
    expect(out).toMatch(/退/)
    // 原文必须留着,排查靠它
    expect(out).toContain(raw)
  })

  it('内容审核(网关实测的上游原话)', () => {
    const raw =
      'task failed with status: FAIL, message: Your request was blocked by our moderation system (ErrCode 70000)'
    const out = translateKlingError(raw)
    expect(out).toMatch(/审核/)
    expect(out).toContain(raw)
  })

  it('网关目录里没有可灵通道:指向密钥分组,而不是万相', () => {
    const out = translateKlingError('网关视频 API 503: model_not_found: kling-v4-omni-vod')
    expect(out).toMatch(/可灵/)
    expect(out).not.toMatch(/万相/)
  })

  it('认不出的原样返回,不套「生成失败，请重试」盖掉线索', () => {
    const raw = '网关视频 API 502: bad gateway'
    expect(translateKlingError(raw)).toBe(raw)
  })

  it('只认可灵:别的模型的 model_not_found 不归这里翻(交给万相那张表)', () => {
    const raw = '网关视频 API 503: model_not_found: wan3.0-video'
    expect(translateKlingError(raw)).toBe(raw)
  })
})

describe('translateVideoTaskError 串联', () => {
  it('可灵的并发提示不会被万相的「限流」条目抢先(那条会让用户去减少卡片却不提退款)', () => {
    const out = translateVideoTaskError('GenerateVideo task reached the maximum concurrency. (ErrCode 70000)')
    expect(out).toMatch(/可灵/)
    // 只包一层:原文只出现一次
    expect(out.split('GenerateVideo task reached').length - 1).toBe(1)
  })

  it('万相的 model_not_found 仍照旧翻成万相的提示', () => {
    expect(translateVideoTaskError('网关视频 API 503: model_not_found: wan3.0-video')).toMatch(/万相/)
  })
})
