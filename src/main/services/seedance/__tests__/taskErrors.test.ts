// @vitest-environment node
/**
 * 上游裸错误 → 人话的翻译表(从已删除的 vvdance `assets.ts` 里搬出来的那一半)。
 * 真人检测两条在 `assetRefRewrite.test.ts`,这里补样片 / 素材不存在 / 原样放行。
 */
import { describe, expect, it } from 'vitest'
import { translateSeedanceTaskError } from '../taskErrors'

describe('translateSeedanceTaskError', () => {
  it('样片任务找不到:点明「同账号同计费池」,不带原 JSON', () => {
    const text = translateSeedanceTaskError('网关视频 API 400: {"code":"task_origin_not_exist"}')
    expect(text).toContain('同一个账号、同一个计费池')
    expect(text).not.toContain('task_origin_not_exist')
  })

  it('样片没成功 / 不是样片,各说各的', () => {
    expect(translateSeedanceTaskError('invalid_draft_task: draft task not succeeded')).toContain('还没有成功')
    expect(translateSeedanceTaskError('invalid_draft_task: not a draft')).toContain('不是 Seedance 2.5 样片')
  })

  it('素材不存在:说清是素材库按计费池隔离,带 content 下标与 request id', () => {
    const text = translateSeedanceTaskError(
      'The specified asset asset-20260101-abcde is not found. content[3] Request id: 0217abc-def',
    )
    expect(text).toContain('asset://asset-20260101-abcde(content[3])')
    expect(text).toContain('按账户和计费池隔离')
    expect(text).toContain('Request id: 0217abc-def')
  })

  it('以前 vvdance 站点隔离那句(LOCAL_ASSET_NOT_FOUND)不再翻译 —— 那条路已经删了', () => {
    const raw = 'Seedance API 400: LOCAL_ASSET_NOT_FOUND'
    expect(translateSeedanceTaskError(raw)).toBe(raw)
  })

  it('认不出的错误原样返回', () => {
    expect(translateSeedanceTaskError('Seedance API 429: quota exceeded')).toBe('Seedance API 429: quota exceeded')
  })
})
