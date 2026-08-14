import { describe, expect, it } from 'vitest'

import {
  SEEDANCE_MODEL_CAPABILITIES,
  capabilitiesFor,
  validateSeedanceRequest,
} from '../../../../types/seedance'

/**
 * 能力表是「9/3/3」「4-15」这类硬编码的唯一去处 —— 它们此前散在 videoTools /
 * videoWorkbenchTools / modes / cardSpec 至少五处,加一个模型就要改五处。
 *
 * 数字全部出自 vvdance 开发文档(版本 2026-08-08)第 2.2.1 / 2.3 / 4.9 节。
 */
describe('SEEDANCE_MODEL_CAPABILITIES', () => {
  it('2.5 放宽到 30 秒、30/10/10 素材,并支持 edit/extend', () => {
    const caps = capabilitiesFor('2.5')
    expect(caps.duration).toEqual({ min: 4, max: 30 })
    expect(caps.maxImages).toBe(30)
    expect(caps.maxVideos).toBe(10)
    expect(caps.maxAudios).toBe(10)
    expect(caps.maxMaterialsTotal).toBe(50)
    expect(caps.taskModes).toEqual(['edit', 'extend'])
    expect(caps.audioOnlyReference).toBe(true)
  })

  it('2.5 不支持 4k —— 只有 2.0 标准档支持(文档 2.2.1)', () => {
    expect(capabilitiesFor('2.5').resolutions).toEqual(['480p', '720p'])
    expect(capabilitiesFor('2.0').resolutions).toContain('4k')
    expect(capabilitiesFor('2.0-fast').resolutions).not.toContain('4k')
    expect(capabilitiesFor('2.0-mini').resolutions).not.toContain('4k')
  })

  it('1080p 也只有 2.0 —— 收编 videoTools 原有的实战规则，不因建表而放宽', () => {
    expect(capabilitiesFor('2.0').resolutions).toContain('1080p')
    for (const alias of ['2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(capabilitiesFor(alias).resolutions).not.toContain('1080p')
    }
  })

  it('擦除字幕只有 2.0 与 2.0-fast 支持(文档 2.4)', () => {
    expect(capabilitiesFor('2.0').subtitleErase).toBe(true)
    expect(capabilitiesFor('2.0-fast').subtitleErase).toBe(true)
    expect(capabilitiesFor('2.0-mini').subtitleErase).toBe(false)
    expect(capabilitiesFor('2.5').subtitleErase).toBe(false)
  })

  it('2.0 家族维持 4-15 与 9/3/3,不被 2.5 带偏', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini'] as const) {
      const caps = capabilitiesFor(alias)
      expect(caps.duration).toEqual({ min: 4, max: 15 })
      expect([caps.maxImages, caps.maxVideos, caps.maxAudios]).toEqual([9, 3, 3])
      expect(caps.taskModes).toEqual([])
    }
  })

  it('每个别名都在表里(新增模型时漏填会在这里红)', () => {
    expect(Object.keys(SEEDANCE_MODEL_CAPABILITIES).sort()).toEqual([
      '2.0',
      '2.0-fast',
      '2.0-mini',
      '2.5',
      'wan3',
    ])
  })

  it('画幅按模型分:万相有 adaptive 没有 21:9,Seedance 反过来', () => {
    // 这两个数字曾经写死在 WorkbenchCard 的一个数组里,于是万相卡片上摆着一个
    // 提交必被拒的 21:9,却没有它官方的默认值 adaptive。
    const wan3 = capabilitiesFor('wan3').ratios
    expect(wan3).toContain('adaptive')
    expect(wan3).not.toContain('21:9')

    const seedance = capabilitiesFor('2.0').ratios
    expect(seedance).toContain('21:9')
    expect(seedance).not.toContain('adaptive')
  })

  it('seed 上限按模型分 —— 万相只到 2147483647', () => {
    // 官方写明 [0, 2147483647],比 Seedance 的 uint32 小一半。差这一位的后果是
    // 界面收下了用户填的大数,上游拒了。
    expect(capabilitiesFor('wan3').seedMax).toBe(2_147_483_647)
    expect(capabilitiesFor('2.0').seedMax).toBe(4_294_967_295)
  })

  it('每个模型都声明了 provider 与可用模式', () => {
    for (const alias of Object.keys(SEEDANCE_MODEL_CAPABILITIES) as VideoModelAlias[]) {
      const caps = capabilitiesFor(alias)
      expect(['vvdance', 'miau']).toContain(caps.provider)
      expect(caps.modes.length).toBeGreaterThan(0)
      // 文生视频是所有模型的最低保证,没有它这张卡什么都提交不了。
      expect(caps.modes).toContain('text2video')
    }
  })

  // 回归:第一版把 UI 模式 `edit_video/extend_video` 与上游参数 `taskModes` 当成
  // 了一回事,于是把 2.0 家族的这两个模式砍掉了。实际上它们 Seedance 全家都有 ——
  // 2.5 之前只是素材组合预设(edit 带图+视频+音频、extend 只带视频),发出去是一次
  // 普通生成,`taskModeForCard` 不会为它们派生 taskMode。
  it('Seedance 全家都有编辑/延长视频模式,taskMode 才是 2.5 独有', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      const caps = capabilitiesFor(alias)
      expect(caps.modes).toContain('edit_video')
      expect(caps.modes).toContain('extend_video')
    }
    expect(capabilitiesFor('2.0').taskModes).toEqual([])
    expect(capabilitiesFor('2.5').taskModes).toEqual(['edit', 'extend'])
  })

  it('今天真正被模式白名单收窄的只有万相 3.0', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(capabilitiesFor(alias).modes).toHaveLength(7)
    }
    expect(capabilitiesFor('wan3').modes).toHaveLength(4)
  })
})

describe('万相 3.0 能力', () => {
  it('多模态上限 10/5/5、时长 2-30、三档分辨率', () => {
    const caps = capabilitiesFor('wan3')
    expect([caps.maxImages, caps.maxVideos, caps.maxAudios]).toEqual([10, 5, 5])
    expect(caps.duration).toEqual({ min: 2, max: 30 })
    expect(caps.resolutions).toEqual(['480p', '720p', '1080p'])
  })

  it('走 miau,允许纯音频参考,没有擦字幕', () => {
    const caps = capabilitiesFor('wan3')
    expect(caps.provider).toBe('miau')
    expect(caps.audioOnlyReference).toBe(true)
    expect(caps.subtitleErase).toBe(false)
  })

  it('只开四种模式 —— 不含参考图与编辑/延长', () => {
    expect(capabilitiesFor('wan3').modes).toEqual([
      'text2video',
      'first_frame',
      'first_last_frame',
      'multimodal_ref',
    ])
  })

  it('时长接受 -1(智能时长)与 2 秒下限', () => {
    expect(validateSeedanceRequest('wan3', { duration: -1 })).toEqual([])
    expect(validateSeedanceRequest('wan3', { duration: 2 })).toEqual([])
    expect(validateSeedanceRequest('wan3', { duration: 1 })).not.toEqual([])
    expect(validateSeedanceRequest('wan3', { duration: 31 })).not.toEqual([])
  })

  it('分辨率按内部小写口径校验(大写转换留给上行组包)', () => {
    expect(validateSeedanceRequest('wan3', { resolution: '1080p' })).toEqual([])
    expect(validateSeedanceRequest('wan3', { resolution: '4k' })).not.toEqual([])
  })
})

describe('validateSeedanceRequest', () => {
  it('放行一次普通的 2.5 请求', () => {
    expect(
      validateSeedanceRequest('2.5', { duration: 30, resolution: '720p' }),
    ).toEqual([])
  })

  it('挡下 2.5 的 4k —— 不然要等上游 400 才知道', () => {
    const errors = validateSeedanceRequest('2.5', { duration: 5, resolution: '4k' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/4k/)
  })

  it('挡下超出该模型时长上限的值,-1 永远放行', () => {
    expect(validateSeedanceRequest('2.0', { duration: 30 })[0]).toMatch(/4-15/)
    expect(validateSeedanceRequest('2.5', { duration: 31 })[0]).toMatch(/4-30/)
    expect(validateSeedanceRequest('2.0', { duration: -1 })).toEqual([])
    expect(validateSeedanceRequest('2.5', { duration: -1 })).toEqual([])
  })

  it('edit / extend 必须带视频参考(文档 4.9)', () => {
    expect(
      validateSeedanceRequest('2.5', { taskMode: 'edit', duration: -1, videos: 0 })[0],
    ).toMatch(/视频/)
    expect(
      validateSeedanceRequest('2.5', { taskMode: 'extend', duration: 10, videos: 1 }),
    ).toEqual([])
  })

  it('edit 锁死 -1 时长', () => {
    expect(
      validateSeedanceRequest('2.5', { taskMode: 'edit', duration: 10, videos: 1 })[0],
    ).toMatch(/-1/)
    expect(
      validateSeedanceRequest('2.5', { taskMode: 'edit', duration: -1, videos: 1 }),
    ).toEqual([])
  })

  it('2.0 家族不认 taskMode', () => {
    expect(
      validateSeedanceRequest('2.0', { taskMode: 'edit', duration: -1, videos: 1 })[0],
    ).toMatch(/2\.5/)
  })

  it('按模型上限挡素材超量', () => {
    expect(validateSeedanceRequest('2.0', { images: 10 })[0]).toMatch(/9/)
    expect(validateSeedanceRequest('2.5', { images: 10 })).toEqual([])
    expect(validateSeedanceRequest('2.5', { images: 31 })[0]).toMatch(/30/)
    expect(validateSeedanceRequest('2.5', { videos: 11 })[0]).toMatch(/10/)
    // 满配正好是 30+10+10=50,即文档给的总数上限 —— 单类不超就一定不超总数。
    expect(validateSeedanceRequest('2.5', { images: 30, videos: 10, audios: 10 })).toEqual([])
  })
})
