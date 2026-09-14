import { describe, it, expect } from 'vitest'
import { groupModelsByVendor, MODEL_VENDORS } from '../modelVendors'
import { ApiService } from '../ApiService'

/**
 * 顶栏模型选择器按厂商聚合(腾讯 image 单开一档),分组逻辑在 groupModelsByVendor。
 * 这里既验函数本身,也拿真实模型表验「每个模型都填了 vendor」——漏填的会掉进「其他」,
 * 用户在下拉里看到「其他 · 1」就是这条没守住。
 */
describe('groupModelsByVendor', () => {
  it('按 vendor 分桶、按厂商 order 排序、组内保持输入顺序', () => {
    const groups = groupModelsByVendor({
      'gpt-a': { name: 'A', vendor: 'openai' },
      'tencent-1': { name: 'T1', vendor: 'tencent' },
      'gpt-b': { name: 'B', vendor: 'openai' },
      'seedream': { name: 'S', vendor: 'bytedance' },
    })
    expect(groups.map((g) => g.vendorKey)).toEqual(['bytedance', 'tencent', 'openai'])
    expect(groups.find((g) => g.vendorKey === 'openai')?.models.map((m) => m.key)).toEqual(['gpt-a', 'gpt-b'])
    expect(groups.find((g) => g.vendorKey === 'tencent')?.meta.name).toBe('腾讯')
  })

  it('没填 / 填了未知 vendor 的模型落到「其他」并排在最后', () => {
    const groups = groupModelsByVendor({
      'x': { name: 'X' },
      'y': { name: 'Y', vendor: 'nobody-knows' },
      'g': { name: 'G', vendor: 'google' },
    })
    expect(groups.map((g) => g.vendorKey)).toEqual(['google', 'other'])
    expect(groups[1].models.map((m) => m.key)).toEqual(['x', 'y'])
    expect(groups[1].meta).toBe(MODEL_VENDORS.other)
  })

  it('空表返回空数组', () => {
    expect(groupModelsByVendor({})).toEqual([])
  })

  it('真实模型表:腾讯 image 单独一组, 2.5 全在 OpenAI 组, 没有模型掉进「其他」', () => {
    const models = new ApiService().getAllModels()
    const groups = groupModelsByVendor(models)
    const byKey = Object.fromEntries(groups.map((g) => [g.vendorKey, g.models.map((m) => m.key)]))

    expect(byKey.other).toBeUndefined()
    expect(byKey.tencent).toContain('custom-imagemodel-gt')
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-all']) {
      expect(byKey.openai).toContain(id)
    }
    // 分组不丢模型:所有组合起来 == 模型表
    expect(groups.flatMap((g) => g.models.map((m) => m.key)).sort()).toEqual(Object.keys(models).sort())
  })
})
