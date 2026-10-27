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

// 「+ 添加」卡必须永远排在最后一张**之后**的那一格。
//
// 背景:它的横向位置原本是 `columns % 12`,满 12 张时绕回第 0 格,叠在第一张底下 ——
// 于是参考图一到 12 张,加号就「消失」了,用户只能删一张再加(见 2026-09-22 反馈:
// 22/30 张铺开后没有再次添加素材的按钮)。这里断言的是「不与任何素材同格」。
describe('素材堆:「+ 添加」卡在任何数量下都不能被素材盖住', () => {
  const addStyle = (): string =>
    screen.getByRole('button', { name: '添加参考图' }).getAttribute('style') ?? ''

  it('正好 12 张(满一行)时,添加卡排在第 13 格,而不是绕回第 0 格', () => {
    renderStack(12)
    expect(addStyle()).toContain('--expand-left: 768px') // 12 * 64
    expect(addStyle()).toContain('--expand-top: 0px')
  })

  it('22 张收起态:添加卡仍在首行「+N」角标右侧(容器宽度已为它留位)', () => {
    renderStack(22)
    expect(addStyle()).toContain('--expand-left: 768px')
    expect(addStyle()).toContain('--expand-top: 0px')
    expect(screen.getByTestId('vw-stack-image').getAttribute('style')).toContain(`width: ${13 * 64 + 8}px`)
  })

  it('22 张展开后:添加卡跟到最后一张后面(第 2 行第 11 格)', () => {
    renderStack(22)
    fireEvent.click(screen.getByRole('button', { name: /展开全部/ }))
    expect(addStyle()).toContain('--expand-left: 640px') // (22 % 12) * 64
    expect(addStyle()).toContain('--expand-top: 64px') // floor(22 / 12) * 64
  })

  it('24 张展开后正好填满两行:添加卡另起第 3 行,容器高度也要把这一行算进去', () => {
    renderStack(24)
    fireEvent.click(screen.getByRole('button', { name: /展开全部/ }))
    expect(addStyle()).toContain('--expand-left: 0px')
    expect(addStyle()).toContain('--expand-top: 128px')
    expect(screen.getByTestId('vw-stack-image').getAttribute('style')).toContain(`height: ${3 * 64 + 12}px`)
  })

  it('添加卡叠放层级高于任何一张素材 —— 同格兜底也不能被盖住', () => {
    renderStack(22)
    const z = Number.parseInt(/z-index:\s*(\d+)/.exec(addStyle())?.[1] ?? '0', 10)
    expect(z).toBeGreaterThan(22)
  })

  it('到上限 30 张时不再出现添加卡', () => {
    renderStack(30)
    expect(screen.queryByRole('button', { name: '添加参考图' })).toBeNull()
  })
})
