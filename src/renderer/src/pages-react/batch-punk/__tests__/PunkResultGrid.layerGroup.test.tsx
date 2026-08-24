import { describe, it, expect } from 'vitest'
import { groupBatchItems } from '../PunkResultGrid'
import type { BatchItem } from '../../../stores/useBatchStore'

function done(id: string, extra: Partial<BatchItem> = {}): BatchItem {
  return {
    id,
    prompt: `p-${id}`,
    status: 'done',
    resultUrl: `https://x/${id}.png`,
    ...extra,
  }
}

function layer(id: string, gid: string, zIndex: number, name?: string): BatchItem {
  return done(id, {
    prompt: '',
    layerDecomposition: true,
    layerGroupId: gid,
    layer: { zIndex, ...(name ? { name } : {}) },
  })
}

describe('groupBatchItems', () => {
  it('普通项一项一卡，顺序不变（批量页的卡片顺序是用户的心智锚点）', () => {
    const items = [done('a'), done('b'), done('c')]
    const out = groupBatchItems(items)
    expect(out.map((e) => e.item.id)).toEqual(['a', 'b', 'c'])
    expect(out.every((e) => e.group === undefined)).toBe(true)
  })

  it('同组图层收成一张卡，成员齐全', () => {
    const items = [layer('base', 'g1', 0), layer('l1', 'g1', 1), layer('l2', 'g1', 2)]
    const out = groupBatchItems(items)
    expect(out).toHaveLength(1)
    expect(out[0].group?.map((i) => i.id)).toEqual(['base', 'l1', 'l2'])
  })

  it('封面让位给底图 —— 拿透明图层当封面等于一张空白卡', () => {
    // 入队序里图层在前、底图在后（上游返回序不保证）
    const items = [layer('top', 'g1', 2), layer('base', 'g1', 0), layer('mid', 'g1', 1)]
    const out = groupBatchItems(items)
    expect(out[0].item.id).toBe('base')
  })

  it('图层组与普通项混排时各自保位', () => {
    const items = [
      done('plain1'),
      layer('base', 'g1', 0),
      layer('l1', 'g1', 1),
      done('plain2'),
    ]
    const out = groupBatchItems(items)
    expect(out.map((e) => e.item.id)).toEqual(['plain1', 'base', 'plain2'])
    expect(out[1].group).toHaveLength(2)
  })

  it('两次拆分互不混淆（按 layerGroupId 分，不按相邻）', () => {
    const items = [
      layer('a0', 'g1', 0),
      layer('b0', 'g2', 0),
      layer('a1', 'g1', 1),
      layer('b1', 'g2', 1),
    ]
    const out = groupBatchItems(items)
    expect(out).toHaveLength(2)
    expect(out[0].group?.map((i) => i.id)).toEqual(['a0', 'a1'])
    expect(out[1].group?.map((i) => i.id)).toEqual(['b0', 'b1'])
  })

  it('还在生成中的拆分项也归组（不会先平铺一批再突然收起来）', () => {
    const items = [
      { ...layer('base', 'g1', 0), status: 'generating' as const, resultUrl: undefined },
      layer('l1', 'g1', 1),
    ]
    const out = groupBatchItems(items)
    expect(out).toHaveLength(1)
    expect(out[0].group).toHaveLength(2)
  })
})
