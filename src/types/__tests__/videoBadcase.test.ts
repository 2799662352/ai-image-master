// 「效果反馈」入口资格与问题类型枚举。

import { describe, expect, it } from 'vitest'
import { ALL_VIDEO_MODEL_ALIASES } from '../seedance'
import {
  VIDEO_BADCASE_MODELS,
  VIDEO_BADCASE_TYPES,
  canReportVideoBadcase,
  isVideoBadcaseType,
} from '../videoBadcase'

const base = { status: 'succeeded', billing: 'platform', model: '2.5', taskId: 'task_abc123' } as const

describe('canReportVideoBadcase', () => {
  it('已完成 + Seedance 2.x + 走网关(task_ 号):可以', () => {
    expect(canReportVideoBadcase(base)).toBe(true)
  })

  it('Seedance 2.x 全家都认', () => {
    for (const model of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(canReportVideoBadcase({ ...base, model })).toBe(true)
    }
  })

  it('万相 / 可灵 / 其它模型:不给入口(网关会回「不是火山 Seedance 任务」)', () => {
    for (const model of ['wan3', 'wan3-prime', 'kling4', 'kling4-omni', 'depth'] as const) {
      expect(canReportVideoBadcase({ ...base, model })).toBe(false)
    }
  })

  it('没出片就没有效果问题:非「已完成」一律不给', () => {
    for (const status of ['idle', 'queued', 'running', 'failed', 'cancelled']) {
      expect(canReportVideoBadcase({ ...base, status })).toBe(false)
    }
  })

  it('自填 Key 直连:不给(任务号是供应商的 cgt-,且没经过我们的网关)', () => {
    expect(canReportVideoBadcase({ ...base, billing: 'own-key' })).toBe(false)
    expect(canReportVideoBadcase({ ...base, billing: 'own-key', taskId: 'task_abc123' })).toBe(false)
  })

  it('历史版本没存计费来源(undefined):看任务号形状', () => {
    expect(canReportVideoBadcase({ ...base, billing: undefined })).toBe(true)
    expect(canReportVideoBadcase({ ...base, billing: undefined, taskId: 'cgt-2026-xyz' })).toBe(false)
  })

  it('任务号缺失 / 只有前缀 / 前后有空白', () => {
    expect(canReportVideoBadcase({ ...base, taskId: undefined })).toBe(false)
    expect(canReportVideoBadcase({ ...base, taskId: '' })).toBe(false)
    expect(canReportVideoBadcase({ ...base, taskId: 'task_' })).toBe(false)
    expect(canReportVideoBadcase({ ...base, taskId: '  task_abc  ' })).toBe(true)
  })

  it('白名单里的模型都是真实存在的别名(改名时这里会红)', () => {
    for (const m of VIDEO_BADCASE_MODELS) expect(ALL_VIDEO_MODEL_ALIASES).toContain(m)
  })
})

describe('问题类型枚举', () => {
  it('与火山 Case 平台官方 11 个值逐字一致', () => {
    expect(VIDEO_BADCASE_TYPES.map((t) => t.value)).toEqual([
      'character_id_drift',
      'subtitle_generation_error',
      'logo_watermark_generated',
      'style_drift',
      'regular_flickering',
      'extended_video_joint_jump',
      'duplicate_character_appearance',
      'audio_end_noise',
      'chinese_pronunciation_error',
      'voice_tone_reference_error',
      'other',
    ])
  })

  it('每个类型都有中文名,且不重复', () => {
    const labels = VIDEO_BADCASE_TYPES.map((t) => t.label)
    expect(labels.every((l) => l.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('isVideoBadcaseType', () => {
    expect(isVideoBadcaseType('style_drift')).toBe(true)
    expect(isVideoBadcaseType('Style_Drift')).toBe(false)
    expect(isVideoBadcaseType(undefined)).toBe(false)
    expect(isVideoBadcaseType(1)).toBe(false)
  })
})
