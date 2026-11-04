// 工作台样片规则:开关何时生效、提交分辨率、「生成 1080P / 4K 成片」何时可点。

import { describe, expect, it } from 'vitest'
import { SEEDANCE_DRAFT_TTL_MS } from '../../../../../types/seedance'
import {
  draftFinalAvailability,
  draftFinalLabel,
  draftFinalResolutionOf,
  draftToggleAvailability,
  effectiveDraft,
  runResolution,
  submitResolution,
} from '../seedanceDraft'

describe('样片开关', () => {
  it('只有 2.5 生效;换到别的模型开关保留但不发', () => {
    expect(effectiveDraft({ draft: true, model: '2.5' })).toBe(true)
    expect(effectiveDraft({ draft: true, model: '2.0' })).toBe(false)
    expect(effectiveDraft({ model: '2.5' })).toBe(false)
  })

  it('样片固定 480p,关掉后回到卡片设置', () => {
    expect(submitResolution({ draft: true, model: '2.5', resolution: '720p' })).toBe('480p')
    expect(submitResolution({ model: '2.5', resolution: '720p' })).toBe('720p')
  })

  it('自填 Key / 非 2.5 时开关置灰并说明原因', () => {
    expect(draftToggleAvailability('2.5', 'platform')).toEqual({ available: true })
    expect(draftToggleAvailability('2.5', 'own-key').reason).toContain('平台余额')
    expect(draftToggleAvailability('2.0', 'platform').reason).toContain('2.5')
  })

  it('已出片那一轮的实际分辨率:样片 480p、成片 1080p', () => {
    expect(runResolution({ draftRun: true, resolution: '720p' })).toBe('480p')
    expect(runResolution({ fromDraftTaskId: 'task_x', resolution: '720p' })).toBe('1080p')
    expect(runResolution({ resolution: '720p' })).toBe('720p')
  })

  it('样片升 4K 的那一轮实际分辨率是 4k;旧卡没有这个字段 = 1080p', () => {
    expect(runResolution({ fromDraftTaskId: 'task_x', draftFinalResolution: '4k', resolution: '720p' })).toBe('4k')
    expect(runResolution({ fromDraftTaskId: 'task_x', draftFinalResolution: '1080p', resolution: '720p' })).toBe('1080p')
    // 不是成片的卡,哪怕残留了这个字段也不能影响分辨率(样片 / 普通卡不看它)
    expect(runResolution({ draftRun: true, draftFinalResolution: '4k', resolution: '720p' })).toBe('480p')
    expect(runResolution({ draftFinalResolution: '4k', resolution: '720p' })).toBe('720p')
  })
})

describe('成片分辨率的取值', () => {
  it('认得 1080p / 4k;缺省与不认识的一律 1080p', () => {
    expect(draftFinalResolutionOf({ draftFinalResolution: '4k' })).toBe('4k')
    expect(draftFinalResolutionOf({ draftFinalResolution: '1080p' })).toBe('1080p')
    expect(draftFinalResolutionOf({})).toBe('1080p')
    expect(draftFinalResolutionOf({ draftFinalResolution: '720p' as never })).toBe('1080p')
  })

  it('成片选项的名字:大写 P、4K', () => {
    expect(draftFinalLabel('1080p')).toBe('1080P')
    expect(draftFinalLabel('4k')).toBe('4K')
  })
})

describe('生成 1080P / 4K 成片', () => {
  const now = 1_800_000_000_000
  const draft = { draftRun: true, status: 'succeeded' as const, taskId: 'task_x', startedAt: now - 1000 }

  it('成功的样片 + 平台余额 + 7 天内 → 可点', () => {
    expect(draftFinalAvailability(draft, 'platform', now)).toEqual({ show: true, enabled: true })
  })

  it('不是样片 / 还没成功 / 没有任务号 → 不出现', () => {
    expect(draftFinalAvailability({ ...draft, draftRun: undefined }, 'platform', now).show).toBe(false)
    expect(draftFinalAvailability({ ...draft, status: 'running' }, 'platform', now).show).toBe(false)
    expect(draftFinalAvailability({ ...draft, taskId: undefined }, 'platform', now).show).toBe(false)
  })

  it('超过 7 天置灰;切到自填 Key 置灰', () => {
    const old = { ...draft, startedAt: now - SEEDANCE_DRAFT_TTL_MS - 1 }
    const expired = draftFinalAvailability(old, 'platform', now)
    expect(expired.show && !expired.enabled && expired.reason).toContain('7 天')
    const ownKey = draftFinalAvailability(draft, 'own-key', now)
    expect(ownKey.show && !ownKey.enabled && ownKey.reason).toContain('平台余额')
  })
})
