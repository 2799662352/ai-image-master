import { describe, expect, it } from 'vitest'

import {
  ALL_VIDEO_MODEL_ALIASES,
  SEEDANCE_MODEL_CAPABILITIES,
  WORKBENCH_VIDEO_MODEL_ALIASES,
  capabilitiesFor,
  resolutionsFor,
  supportsSeedanceDraft,
  validateSeedanceRequest,
} from '../../../../types/seedance'
import { resolveSeedanceModelId } from '../modelIds'
import { transportFor } from '../../videoTransport'

/**
 * Seedance 2.5 Flash(`doubao-seedance-2-5-flash-261115`,2026-11-16 随 Miau 网关接入)。
 *
 * 数字来自接入文档(`2026-11-16-miau-api-seedance-2.5-flash-seedream-5.5.md`):
 * 480p / 720p、4–30 秒、参考 10 图 / 5 视频 / 5 音频、与 2.5 同样的 edit / extend、**不支持样片**。
 * 「没验证」的那几项(见 `types/seedance.ts` 里 Flash 条目上的注释)这里**不**钉成断言。
 */
describe('Seedance 2.5 Flash 能力', () => {
  const caps = capabilitiesFor('2.5-flash')

  it('480p / 720p,4–30 秒,智能时长', () => {
    expect(caps.resolutions).toEqual(['480p', '720p'])
    expect(caps.duration).toEqual({ min: 4, max: 30 })
    expect(caps.smartDuration).toBe(true)
  })

  it('平台余额与自填 Key 的分辨率口径一致,都没有 1080p / 4k(不像 2.5 平台余额新开了 1080p / 4k)', () => {
    for (const billing of ['platform', 'own-key', undefined] as const) {
      expect(resolutionsFor('2.5-flash', billing), String(billing)).toEqual(['480p', '720p'])
    }
    // 对照:2.5 平台余额确实比自填 Key 宽,这条没有变成 Flash 的口径。
    expect(resolutionsFor('2.5', 'platform').length).toBeGreaterThan(resolutionsFor('2.5', 'own-key').length)
  })

  it('参考素材 10 图 / 5 视频 / 5 音频,合计 20', () => {
    expect([caps.maxImages, caps.maxVideos, caps.maxAudios]).toEqual([10, 5, 5])
    expect(caps.maxMaterialsTotal).toBe(20)
  })

  it('和 2.5 一样支持 edit / extend 与全部七种工作台模式', () => {
    expect(caps.taskModes).toEqual(['edit', 'extend'])
    expect(caps.modes).toEqual(capabilitiesFor('2.5').modes)
    expect(caps.audioOnlyReference).toBe(true)
  })

  it('不支持样片(Draft)—— 样片只有 2.5', () => {
    expect(supportsSeedanceDraft('2.5-flash')).toBe(false)
    expect(supportsSeedanceDraft('2.5')).toBe(true)
  })

  it('是 Seedance 家族:联网搜索有、擦除字幕无、不是源视频变换、不是分镜模型', () => {
    expect(caps.webSearch).toBe(true)
    expect(caps.subtitleErase).toBe(false)
    expect(caps.sourceVideoTransform).toBe(false)
    expect(caps.multiShot).toBe(false)
    expect(caps.documentSlot).toBe(false)
    expect(caps.provider).toBe('vvdance')
  })

  it('同时出现在 MCP 的全模型枚举与工作台下拉里,且紧跟 2.5', () => {
    expect(ALL_VIDEO_MODEL_ALIASES).toContain('2.5-flash')
    const order = WORKBENCH_VIDEO_MODEL_ALIASES
    expect(order).toContain('2.5-flash')
    expect(order.indexOf('2.5-flash')).toBe(order.indexOf('2.5') + 1)
  })

  it('2.5 自己没被改成 Flash 的样子(仍是 30/10/10 + 样片 + 平台余额更宽的分辨率)', () => {
    expect(capabilitiesFor('2.5').maxImages).toBe(30)
    expect(capabilitiesFor('2.5').maxMaterialsTotal).toBe(50)
    expect(Object.keys(SEEDANCE_MODEL_CAPABILITIES).filter((a) => a.startsWith('2.5'))).toEqual(['2.5', '2.5-flash'])
  })
})

describe('Seedance 2.5 Flash 提交校验', () => {
  it('放行 30 秒 720p;31 秒、1080p、4k 都被挡下(平台余额也一样)', () => {
    expect(validateSeedanceRequest('2.5-flash', { duration: 30, resolution: '720p' })).toEqual([])
    expect(validateSeedanceRequest('2.5-flash', { duration: 31 })[0]).toMatch(/4-30/)
    for (const resolution of ['1080p', '4k']) {
      for (const billing of ['platform', 'own-key'] as const) {
        const errors = validateSeedanceRequest('2.5-flash', { resolution, billing })
        expect(errors, `${resolution}/${billing}`).toHaveLength(1)
        expect(errors[0]).toMatch(/480p \/ 720p/)
      }
    }
  })

  it('素材按 Flash 的 10/5/5 挡(2.5 的 30/10/10 在这里超量)', () => {
    expect(validateSeedanceRequest('2.5-flash', { images: 10, videos: 5, audios: 5 })).toEqual([])
    expect(validateSeedanceRequest('2.5-flash', { images: 11 })[0]).toMatch(/10/)
    expect(validateSeedanceRequest('2.5-flash', { videos: 6 })[0]).toMatch(/5/)
    expect(validateSeedanceRequest('2.5-flash', { audios: 6 })[0]).toMatch(/5/)
    // 同一组数在 2.5 上合法 —— 证明挡下的是 Flash 自己的上限而不是通用规则
    expect(validateSeedanceRequest('2.5', { images: 11, videos: 6, audios: 6 })).toEqual([])
  })

  it('edit / extend 的规则与 2.5 相同(必须带视频;edit 锁 -1)', () => {
    expect(validateSeedanceRequest('2.5-flash', { taskMode: 'edit', duration: -1, videos: 1 })).toEqual([])
    expect(validateSeedanceRequest('2.5-flash', { taskMode: 'extend', duration: 10, videos: 1 })).toEqual([])
    expect(validateSeedanceRequest('2.5-flash', { taskMode: 'edit', duration: -1, videos: 0 })[0]).toMatch(/视频/)
    expect(validateSeedanceRequest('2.5-flash', { taskMode: 'edit', duration: 10, videos: 1 })[0]).toMatch(/-1/)
  })

  it('「谁支持 taskMode」的提示从能力表派生:2.0 被拒时同时点名 2.5 与 Flash', () => {
    const message = validateSeedanceRequest('2.0', { taskMode: 'edit', duration: -1, videos: 1 })[0]
    expect(message).toContain('2.5')
    expect(message).toContain('2.5-flash')
    // 反向:不能点名不支持的模型
    expect(message).not.toContain('2.0-fast')
    expect(message).not.toContain('wan3')
  })
})

describe('Seedance 2.5 Flash 的上游 ID 与通道', () => {
  it('别名解析成带日期后缀的网关 ID,与 2.5 不同', () => {
    expect(resolveSeedanceModelId('2.5-flash')).toBe('doubao-seedance-2-5-flash-261115')
    expect(resolveSeedanceModelId('2.5-flash')).not.toBe(resolveSeedanceModelId('2.5'))
  })

  it('走 Seedance 通道且按提交时的钱包选(平台余额 / 自填 Key 各一条),不是万相 / 可灵 / 深度', () => {
    // 注意:认不出的别名本来就按 Seedance 走,所以这条守的不是「Flash 有没有被登记」(那由
    // `Record<VideoModelAlias, …>` 的穷尽性在编译期守),而是「没被登记到别的通道上」。
    const seedanceOwnKey = { kind: 'seedance-own' } as never
    const seedanceGateway = { kind: 'seedance-gateway' } as never
    const wan3 = { kind: 'wan3' } as never
    const kling = { kind: 'kling' } as never
    const depth = { kind: 'depth' } as never
    const registry = { seedanceOwnKey, seedanceGateway, wan3, kling, depth }
    expect(transportFor(registry, '2.5-flash', { billing: 'own-key' })).toBe(seedanceOwnKey)
    expect(transportFor(registry, '2.5-flash', { billing: 'platform' })).toBe(seedanceGateway)
  })
})
