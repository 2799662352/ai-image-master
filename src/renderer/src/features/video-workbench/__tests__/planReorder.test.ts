// 拖拽排序的纯逻辑:剧栏的剧、(后面)分段网格的分段共用。
import { describe, expect, it } from 'vitest'
import { moveIdNear, planReorder } from '../projects'

describe('moveIdNear', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('挪到目标前面 / 后面', () => {
    expect(moveIdNear(ids, 'a', 'c', 'before')).toEqual(['b', 'a', 'c', 'd'])
    expect(moveIdNear(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveIdNear(ids, 'd', 'a', 'before')).toEqual(['d', 'a', 'b', 'c'])
    expect(moveIdNear(ids, 'a', 'd', 'after')).toEqual(['b', 'c', 'd', 'a'])
  })

  it('挪到自己、或有 id 不在列表里 → null', () => {
    expect(moveIdNear(ids, 'b', 'b', 'before')).toBeNull()
    expect(moveIdNear(ids, 'x', 'b', 'before')).toBeNull()
    expect(moveIdNear(ids, 'b', 'x', 'after')).toBeNull()
  })

  it('不改传进来的数组', () => {
    const src = ['a', 'b', 'c']
    moveIdNear(src, 'a', 'c', 'after')
    expect(src).toEqual(['a', 'b', 'c'])
  })
})

describe('planReorder', () => {
  it('没有置顶:和 moveIdNear 一样', () => {
    expect(planReorder(['a', 'b', 'c', 'd'], [], 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
    expect(planReorder(['a', 'b', 'c', 'd'], [], 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('本来就在那个位置(已相邻)→ null,调用方不必写库', () => {
    expect(planReorder(['a', 'b', 'c'], [], 'b', 'c', 'before')).toBeNull()
    expect(planReorder(['a', 'b', 'c'], [], 'b', 'a', 'after')).toBeNull()
    expect(planReorder(['a', 'b', 'c'], [], 'b', 'b', 'after')).toBeNull()
  })

  it('不允许跨置顶分组(置顶的永远在最上):两个方向都是 null', () => {
    const ids = ['a', 'b', 'c']
    expect(planReorder(ids, ['c'], 'a', 'c', 'before')).toBeNull()
    expect(planReorder(ids, ['c'], 'a', 'c', 'after')).toBeNull()
    expect(planReorder(ids, ['c'], 'c', 'a', 'before')).toBeNull()
  })

  it('在存储顺序上挪:另一组的相对位置原样不动,取消置顶后各回各位', () => {
    // 存储 [a, P, b, c],显示 [P, a, b, c];把 c 挪到 b 前面
    expect(planReorder(['a', 'P', 'b', 'c'], ['P'], 'c', 'b', 'before')).toEqual(['a', 'P', 'c', 'b'])
  })

  it('存储顺序变了但显示顺序没变 → 也算无操作', () => {
    // 存储 [a, P, b]、显示 [P, a, b]:把 b 放到 a 后面,存储变 [a, b, P],显示仍是 [P, a, b]
    expect(planReorder(['a', 'P', 'b'], ['P'], 'b', 'a', 'after')).toBeNull()
  })

  it('置顶组内部可以互相排序', () => {
    expect(planReorder(['a', 'P1', 'P2', 'b'], ['P1', 'P2'], 'P2', 'P1', 'before')).toEqual([
      'a',
      'P2',
      'P1',
      'b',
    ])
  })

  it('id 不在列表里 → null', () => {
    expect(planReorder(['a', 'b'], [], 'x', 'a', 'before')).toBeNull()
  })
})
