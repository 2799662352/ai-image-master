// 素材超过一行时，必须还能看到并操作**每一张**。
//
// 背景：素材堆原本硬编码只渲染前 12 张，剩下的用一个「+N」角标概括掉。Seedance 2.5
// 一张卡收 30 张参考图，于是有 18 张既看不到、也删不掉、更拖不动 —— 而
// 「第 N 张 = reference image N」现在是写进 skill 的硬规矩，拖不动就等于改不了
// 角色和参考图的绑定关系。所以这里断言的是「全部渲染 + 全部可操作」，
// 而不是「角标数字对不对」。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'
import { MaterialStack } from '../MaterialStack'

function mats(n: number): VideoWorkbenchMaterial[] {
  return Array.from({ length: n }, (_, i) => ({ name: `m${i}.png`, src: `file:///m${i}.png` }))
}

function renderStack(n: number, onRemove = vi.fn(), onReorder = vi.fn()) {
  const materials = mats(n)
  render(
    <MaterialStack
      kind="image"
      label="参考图"
      materials={materials}
      limit={30}
      accept="image/*"
      onAdd={() => {}}
      onRemove={onRemove}
      onReorder={onReorder}
      thumbSrcs={materials.map(() => undefined)}
    />,
  )
  return { materials, onRemove, onReorder }
}

afterEach(cleanup)

describe('素材堆：超出一行时也要能看全、能操作', () => {
  it('30 张全部渲染到 DOM —— 不是只画前 12 张', () => {
    renderStack(30)
    expect(screen.getAllByTestId(/^vw-stack-item-image-\d+$/)).toHaveLength(30)
    // 最后一张必须真的在，不能被角标概括掉。
    expect(screen.getByTestId('vw-stack-item-image-29')).toBeTruthy()
  })

  it('第 20 张也能删 —— 折叠掉的那些原本连 ✕ 都点不到', () => {
    const { onRemove } = renderStack(30)
    const tile = screen.getByTestId('vw-stack-item-image-20')
    const remove = tile.querySelector('.vw-stack-remove')
    expect(remove, '第 20 张缺少删除按钮').toBeTruthy()
    fireEvent.click(remove as Element)
    expect(onRemove).toHaveBeenCalledWith(20)
  })

  it('第 20 张可拖拽换位 —— 序号即身份，拖不动就改不了绑定', () => {
    renderStack(30)
    expect(screen.getByTestId('vw-stack-item-image-20').getAttribute('draggable')).toBe('true')
  })

  it('少于一行时不出现展开开关 —— 别给没必要的东西加一个按钮', () => {
    renderStack(5)
    expect(screen.queryByRole('button', { name: /展开全部|收起/ })).toBeNull()
  })

  it('超出一行时给出展开开关，点开后变成收起', () => {
    renderStack(30)
    const toggle = screen.getByRole('button', { name: /展开全部 30 个参考图/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('+18')

    fireEvent.click(toggle)
    const collapsed = screen.getByRole('button', { name: /收起参考图/ })
    expect(collapsed.getAttribute('aria-expanded')).toBe('true')
  })

  it('收起态所有卡叠在首行；展开后按 12 列换行铺开', () => {
    renderStack(30)
    const at = (i: number) => screen.getByTestId(`vw-stack-item-image-${i}`).getAttribute('style') ?? ''

    // 收起：第 20 张位置被钳到最后一格（叠在「+N」开关底下），不会跑到画布外。
    expect(at(20)).toContain('--expand-left: 704px') // (12-1) * 64
    expect(at(20)).toContain('--expand-top: 0px')

    fireEvent.click(screen.getByRole('button', { name: /展开全部/ }))
    // 展开：第 20 张 = 第 2 行第 9 列。
    expect(at(20)).toContain('--expand-left: 512px') // (20 % 12) * 64
    expect(at(20)).toContain('--expand-top: 64px') // floor(20 / 12) * 64
    // 第 29 张进第 3 行。
    expect(at(29)).toContain('--expand-top: 128px')
  })
})
