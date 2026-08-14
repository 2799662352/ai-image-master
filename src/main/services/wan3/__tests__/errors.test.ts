// 万相错误翻译。每条断言守的是同一件事:翻译要回答「我该怎么办」,
// 而且**不能盖掉上游原文** —— 原码是排查的唯一线索。

import { describe, expect, it } from 'vitest'
import { translateWan3Error } from '../errors'

describe('translateWan3Error', () => {
  it('实测过的三个码都能认出来', () => {
    // 2026-08-14 对着真网关探到的原始回包形态。
    expect(translateWan3Error('万相 API 400: task_not_exist: task_not_exist')).toMatch(/已不存在/)
    expect(translateWan3Error('万相 API 500: model_not_found: …')).toMatch(/没有开通万相/)
    expect(translateWan3Error('万相 API 401: InvalidApiKey: No API-key provided.')).toMatch(/密钥无效/)
  })

  it('内容审核给出「改了才有用」的指引', () => {
    // 原文只说 inappropriate content,用户不改提示词会一直撞同一堵墙。
    const out = translateWan3Error('DataInspectionFailed: input data may contain inappropriate content')
    expect(out).toMatch(/内容审核/)
    expect(out).toMatch(/重复提交同一份内容/)
  })

  it('素材下载失败要指明问题在素材地址上', () => {
    // 这一步是上游来下载我们给的链接,我们这边一切正常 —— 不说清就无从查起。
    expect(translateWan3Error('DownloadFileFailed')).toMatch(/公网访问的素材直链/)
  })

  it('参数错误提示「改掉再来」而不是「重试」,并保留上游列出的合法值', () => {
    // 实测(2026-08-14,用 21:9 探的):这条是异步的 —— 创建回 200/queued,任务
    // 跑了一分钟才失败,而那一分钟计费。劝人重试就是劝他再烧一次钱。
    const raw =
      "task failed, code: InvalidParameter , message: Input should be '16:9', '4:3', '1:1', '3:4', '9:16' or 'adaptive': parameters.ratio"
    const out = translateWan3Error(raw)
    expect(out).toMatch(/改掉/)
    expect(out).not.toMatch(/重试一次|请重试/)
    // 合法值清单来自上游原文,我们不复述 —— 抄一份只会随上游变更过期。
    expect(out).toContain("'16:9', '4:3', '1:1', '3:4', '9:16' or 'adaptive'")
  })

  it('大小写与下划线两种码形都认', () => {
    // 网关有时透传上游原码,有时套一层自己的下划线码。
    expect(translateWan3Error('data_inspection_failed')).toMatch(/内容审核/)
    expect(translateWan3Error('DATAINSPECTIONFAILED')).toMatch(/内容审核/)
  })

  it('永远保留上游原文', () => {
    const raw = 'Throttling: request rate exceeded'
    const out = translateWan3Error(raw)
    expect(out).toMatch(/限流/)
    expect(out).toContain(raw)
  })

  it('认不出的原样返回,不套一句没信息量的「请重试」', () => {
    // 兜底话术会把原文里唯一的线索(上游错误码)盖掉,用户和我们都查不下去。
    const raw = '万相 API 503: SomeBrandNewCode: 上游今天新加的'
    expect(translateWan3Error(raw)).toBe(raw)
  })

  it('空串不炸', () => {
    expect(translateWan3Error('')).toBe('')
  })
})
