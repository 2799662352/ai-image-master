// Seedance 2.5 的分辨率按计费来源分开:平台余额(网关 → 方舟)开放 1080p / 4k,
// 自填 Key 直连(vvdance,文档 2.2.1)仍只有 480p / 720p。成片的 4K 是样片升级的一档。

import { describe, expect, it } from 'vitest'
import {
  AGENT_UHD_REFUSAL,
  SEEDANCE_DRAFT_FINAL_RESOLUTIONS,
  agentUhdRefusal,
  coerceDraftFinalResolution,
  resolutionsFor,
  validateSeedanceRequest,
} from '../seedance'

describe('resolutionsFor', () => {
  it('2.5:平台余额 480p / 720p / 1080p / 4k,自填 Key 只有 480p / 720p', () => {
    expect(resolutionsFor('2.5', 'platform')).toEqual(['480p', '720p', '1080p', '4k'])
    expect(resolutionsFor('2.5', 'own-key')).toEqual(['480p', '720p'])
  })

  it('没带计费来源 = 宽松口径(MCP 预检用),真正按来源把关的是 taskManager', () => {
    expect(resolutionsFor('2.5', undefined)).toEqual(['480p', '720p', '1080p', '4k'])
  })

  it('其它模型两种来源一致 —— 不因为这次改动动到 2.0 / fast / mini / 万相 / 可灵', () => {
    expect(resolutionsFor('2.0', 'platform')).toEqual(['480p', '720p', '1080p', '4k'])
    expect(resolutionsFor('2.0', 'own-key')).toEqual(['480p', '720p', '1080p', '4k'])
    expect(resolutionsFor('2.0-fast', 'platform')).toEqual(['480p', '720p'])
    expect(resolutionsFor('2.0-mini', 'platform')).toEqual(['480p', '720p'])
    expect(resolutionsFor('kling4', 'platform')).toEqual(['720p', '1080p', '2k', '4k'])
  })
})

describe('validateSeedanceRequest × 计费来源', () => {
  it('2.5 + 1080p / 4k:平台余额放行', () => {
    expect(validateSeedanceRequest('2.5', { resolution: '1080p', billing: 'platform' })).toEqual([])
    expect(validateSeedanceRequest('2.5', { resolution: '4k', billing: 'platform' })).toEqual([])
  })

  it('2.5 + 1080p / 4k:自填 Key 拒绝,并说清可用档位', () => {
    for (const resolution of ['1080p', '4k']) {
      const errors = validateSeedanceRequest('2.5', { resolution, billing: 'own-key' })
      expect(errors, resolution).toHaveLength(1)
      expect(errors[0]).toContain('480p / 720p')
    }
  })

  it('不带 billing 的老调用方式行为不变(宽松口径)', () => {
    expect(validateSeedanceRequest('2.5', { resolution: '720p' })).toEqual([])
    expect(validateSeedanceRequest('2.0-fast', { resolution: '1080p' })).toHaveLength(1)
  })
})

describe('样片成片的分辨率', () => {
  it('只有 1080p 和 4k 两档,默认 1080p', () => {
    expect(SEEDANCE_DRAFT_FINAL_RESOLUTIONS).toEqual(['1080p', '4k'])
    expect(coerceDraftFinalResolution(undefined)).toBe('1080p')
  })

  it('载荷不可信:大小写容错,其余一律回落 1080p', () => {
    expect(coerceDraftFinalResolution('4k')).toBe('4k')
    expect(coerceDraftFinalResolution('4K')).toBe('4k')
    expect(coerceDraftFinalResolution(' 1080P ')).toBe('1080p')
    for (const bad of ['720p', '480p', '2k', '8k', '', 4, null, {}]) {
      expect(coerceDraftFinalResolution(bad), String(bad)).toBe('1080p')
    }
  })
})

describe('agentUhdRefusal:4K 只能由用户本人确认,AI 的请求一律挡下', () => {
  it('普通请求:resolution 是 4k(大小写 / 空白容错)就拒绝,并给转告用户的话', () => {
    for (const r of ['4k', '4K', ' 4k ']) {
      expect(agentUhdRefusal({ resolution: r }), r).toBe(AGENT_UHD_REFUSAL)
    }
    expect(AGENT_UHD_REFUSAL).toMatch(/用户/)
    expect(AGENT_UHD_REFUSAL).toMatch(/二次确认/)
  })

  it('成片请求:finalResolution 是 4k 同样拒绝', () => {
    expect(agentUhdRefusal({ finalResolution: '4K' })).toBe(AGENT_UHD_REFUSAL)
  })

  it('样片固定 480p:draft 为真时请求里残留的 4k 不算', () => {
    expect(agentUhdRefusal({ resolution: '4k', draft: true })).toBeNull()
  })

  it('其余分辨率 / 没带分辨率 / 脏值都放行(不替业务校验兜底)', () => {
    for (const r of ['480p', '720p', '1080p', '2k', '', undefined, null, 4, {}]) {
      expect(agentUhdRefusal({ resolution: r as never }), String(r)).toBeNull()
    }
    expect(agentUhdRefusal({})).toBeNull()
    expect(agentUhdRefusal({ finalResolution: '1080p' })).toBeNull()
  })
})
