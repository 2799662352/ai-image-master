// 用户 2026-09-24 实机原文。以前走到万相翻译表的 InvalidParameter 那一条,
// 回一句「参数不合法,上游已指出是哪一个」—— 可这不是参数写错,是素材不在这个库里。

import { describe, expect, it, vi } from 'vitest'
import { translateVideoTaskError } from '../videoTaskError'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const RAW =
  '网关视频 API 400: fail_to_fetch_task: {"error":{"code":"InvalidParameter","message":"The parameter ' +
  '`content[0].image_url.url` specified in the request is not valid: The specified asset ' +
  'asset-20260924140015-hczmn is not found. Request id: 0217902300389568808fc7e9ca3b6569f64b75b5a4eb61eb8841c",' +
  '"param":"content[0].image_url.url","type":"BadRequest"}}'

describe('素材不存在(平台网关)', () => {
  it('翻成「素材在另一个库 / 计费池」并指出是哪一张,保留 request id', () => {
    const out = translateVideoTaskError(RAW)
    expect(out).toContain('asset://asset-20260924140015-hczmn')
    expect(out).toContain('content[0]')
    expect(out).toContain('计费池')
    expect(out).toContain('Request id: 0217902300389568808fc7e9ca3b6569f64b75b5a4eb61eb8841c')
  })

  it('不再被当成「参数不合法」二次包装', () => {
    expect(translateVideoTaskError(RAW)).not.toContain('参数不合法')
  })
})
