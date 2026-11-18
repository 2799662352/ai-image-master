// 视频工作台「渠道 → 模型」选择器的数据层:分组、叫法、每个模型的一行说明。
//
// 全部从能力表现算,所以这里钉的是「现算」这件事 —— 加一个模型或改一个渠道,选择器不用另改清单,
// 而这些测试保证它真的跟着表走。

import { describe, expect, it } from 'vitest'

import {
  ALL_VIDEO_MODEL_ALIASES,
  WORKBENCH_VIDEO_MODEL_ALIASES,
  type SeedanceModelAlias,
} from '../../../../../types/seedance'
import {
  MODEL_LABELS,
  channelGroupOf,
  groupModelsByChannel,
  modelHint,
  modelLabel,
  modelNameInChannel,
} from '../modelChannels'

describe('groupModelsByChannel', () => {
  const groups = groupModelsByChannel(WORKBENCH_VIDEO_MODEL_ALIASES)

  it('渠道顺序:火山方舟 → Roneyun-cn → 阿里万相 → 可灵,组内顺序就是能力表键序', () => {
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ['volcengine', '火山方舟'],
      ['roneyun-cn', 'Roneyun-cn'],
      ['wan', '阿里万相'],
      ['kling', '可灵'],
    ])
    expect(groups.map((g) => g.models)).toEqual([
      ['2.0', '2.0-fast', '2.0-mini', '2.5', '2.5-flash'],
      ['cn-seedance-2.0', 'cn-seedance-2.0-fast', 'cn-seedance-2.0-mini', 'cn-seedance-2.5'],
      ['wan3', 'wan3-prime'],
      ['kling4', 'kling4-omni'],
    ])
  })

  it('每个能进工作台的模型恰好出现一次 —— 不丢、不重', () => {
    const listed = groups.flatMap((g) => g.models)
    expect([...listed].sort()).toEqual([...WORKBENCH_VIDEO_MODEL_ALIASES].sort())
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('深度捕捉(渠道 other,没有工作台模式)不出现在任何一栏', () => {
    expect(ALL_VIDEO_MODEL_ALIASES).toContain('depth')
    expect(groups.flatMap((g) => g.models)).not.toContain('depth')
    // 即使被硬塞进来也不出现 —— 它的渠道不在选择器的清单里。
    expect(groupModelsByChannel(['depth', '2.0']).flatMap((g) => g.models)).toEqual(['2.0'])
  })

  it('没有模型的渠道不画空栏', () => {
    expect(groupModelsByChannel(['kling4']).map((g) => g.id)).toEqual(['kling'])
    expect(groupModelsByChannel([])).toEqual([])
  })

  it('组内保持传入顺序,不按字母重排', () => {
    expect(groupModelsByChannel(['2.5', '2.0']).flatMap((g) => g.models)).toEqual(['2.5', '2.0'])
  })

  it('每栏带着渠道的名字与一句说明', () => {
    for (const g of groups) {
      expect(g.label.length, g.id).toBeGreaterThan(0)
      expect(g.caption.length, g.id).toBeGreaterThan(0)
    }
    expect(groups.find((g) => g.id === 'roneyun-cn')?.caption).toMatch(/公网链接/)
  })
})

describe('channelGroupOf', () => {
  const groups = groupModelsByChannel(WORKBENCH_VIDEO_MODEL_ALIASES)

  it('当前模型在哪一栏就回哪一栏', () => {
    expect(channelGroupOf(groups, '2.5')?.id).toBe('volcengine')
    expect(channelGroupOf(groups, 'cn-seedance-2.5')?.id).toBe('roneyun-cn')
    expect(channelGroupOf(groups, 'kling4-omni')?.id).toBe('kling')
  })

  it('旧存档里认不出的别名回 null,由调用方决定停在哪一栏', () => {
    expect(channelGroupOf(groups, 'seedance-1.0' as SeedanceModelAlias)).toBeNull()
  })
})

describe('叫法', () => {
  it('每个别名都有叫法(穷尽性之外再兜一次:没有空字符串)', () => {
    for (const alias of ALL_VIDEO_MODEL_ALIASES) {
      expect(MODEL_LABELS[alias]?.length, alias).toBeGreaterThan(0)
    }
  })

  it('火山方舟保持老卡片上一直显示的叫法,不带渠道名', () => {
    expect(modelLabel('2.0')).toBe('Seedance 2.0 满血')
    expect(modelLabel('2.5')).toBe('Seedance 2.5')
    expect(modelLabel('2.5-flash')).toBe('Seedance 2.5 Flash')
    expect(modelLabel('2.0-mini')).toBe('Seedance 2.0 Mini(最省)')
  })

  /**
   * 🧬 变异点:把任一 cn 叫法里的「 · Roneyun-cn」去掉,这条必红 ——
   * 否则「Seedance 2.0 满血」在按钮 / 4K 确认框里有两个,分不清是哪条渠道。
   */
  it('Roneyun-cn 的同名模型带渠道名,与火山的叫法不重复', () => {
    expect(modelLabel('cn-seedance-2.0')).toBe('Seedance 2.0 满血 · Roneyun-cn')
    expect(modelLabel('cn-seedance-2.5')).toBe('Seedance 2.5 · Roneyun-cn')
    const labels = ALL_VIDEO_MODEL_ALIASES.map((alias) => modelLabel(alias))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('认不出的别名原样显示别名,不显示成空白', () => {
    expect(modelLabel('seedance-1.0' as SeedanceModelAlias)).toBe('seedance-1.0')
  })

  it('右栏里去掉结尾的渠道名(渠道已经写在左栏和标题上了),只去结尾那一段', () => {
    expect(modelNameInChannel('cn-seedance-2.0-fast')).toBe('Seedance 2.0 Fast')
    expect(modelNameInChannel('cn-seedance-2.5')).toBe('Seedance 2.5')
    // 火山 / 万相 / 可灵本来就不带,原样。
    expect(modelNameInChannel('2.0')).toBe('Seedance 2.0 满血')
    expect(modelNameInChannel('wan3-prime')).toBe('万相 3.0 Prime')
    // 深度捕捉没有渠道名可去。
    expect(modelNameInChannel('depth')).toBe('深度捕捉')
  })
})

describe('modelHint(每个模型下面那一行小字,读能力表)', () => {
  it('火山 2.5:平台余额下最高 4k,带样片', () => {
    expect(modelHint('2.5', 'platform')).toBe('4–30 秒 · 最高 4k · 参考 30 图 / 10 视频 / 10 音频 · 可编辑 / 延长 · 样片')
  })

  it('分辨率按计费来源算:自填 Key 下 2.5 只到 720p', () => {
    expect(modelHint('2.5', 'own-key')).toContain('最高 720p')
    expect(modelHint('2.5', 'platform')).toContain('最高 4k')
  })

  /**
   * 网关 2026-11-18 起透传样片(new-api #206/#207/#209),cn-2.5 与火山 2.5 同规格同能力,
   * 说明里写「样片」与卡片上的开关一致。2.0 三档上游仍拒 draft(mini 实测 400),不写。
   *
   * 🧬 变异点:把 `cn-seedance-2.5` 的 `draft` 改回 false,第一条必红;
   * 把 `cn-seedance-2.0-mini` 的 `draft` 改成 true,第二条必红。
   */
  it('Roneyun-cn 的 2.5:与火山 2.5 同规格,也写「样片」', () => {
    expect(modelHint('cn-seedance-2.5', 'platform')).toBe(modelHint('2.5', 'platform'))
    expect(modelHint('cn-seedance-2.5', 'platform')).toBe(
      '4–30 秒 · 最高 4k · 参考 30 图 / 10 视频 / 10 音频 · 可编辑 / 延长 · 样片',
    )
  })

  it('Roneyun-cn 的 2.0 三档:不写「样片」(上游不收)', () => {
    for (const m of ['cn-seedance-2.0', 'cn-seedance-2.0-fast', 'cn-seedance-2.0-mini'] as const) {
      expect(modelHint(m, 'platform'), m).not.toContain('样片')
    }
  })

  it('2.0 家族:没有「可编辑 / 延长」(那是 taskMode,2.0 不认)', () => {
    expect(modelHint('2.0', 'platform')).toBe('4–15 秒 · 最高 4k · 参考 9 图 / 3 视频 / 3 音频')
    expect(modelHint('cn-seedance-2.0-mini', 'platform')).toBe('4–15 秒 · 最高 720p · 参考 9 图 / 3 视频 / 3 音频')
  })

  it('可灵 4.0 只收首帧 / 尾帧,不写成「参考 2 图」;Omni 才有参考素材', () => {
    const plain = modelHint('kling4', 'platform')
    expect(plain).toContain('只收首帧 / 尾帧')
    expect(plain).not.toMatch(/参考/)
    expect(plain).toContain('分镜')
    const omni = modelHint('kling4-omni', 'platform')
    expect(omni).toContain('参考 10 图 / 5 视频')
    expect(omni).not.toContain('音频')
  })

  it('万相带文档 / 链接槽', () => {
    expect(modelHint('wan3', 'platform')).toContain('文档 / 链接')
    expect(modelHint('2.0', 'platform')).not.toContain('文档 / 链接')
  })

  it('认不出的别名回空串,不抛', () => {
    expect(modelHint('seedance-1.0' as SeedanceModelAlias, 'platform')).toBe('')
  })
})
