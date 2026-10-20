// 通用右键菜单:打开/关闭条件、键盘导航、禁用项、portal 到 body。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useContextMenu, type ContextMenuItem } from '../ContextMenu'

afterEach(() => cleanup())

function Harness({ items }: { items: ContextMenuItem[] }) {
  const menu = useContextMenu()
  return (
    <div>
      <div data-testid="target" onContextMenu={(e) => menu.open(e, items)}>
        目标
      </div>
      <div data-testid="other">别处</div>
      {menu.node}
    </div>
  )
}

const items = (over: Partial<Record<string, Partial<ContextMenuItem>>> = {}): ContextMenuItem[] => [
  { id: 'a', label: '甲', onSelect: vi.fn(), ...over.a },
  { id: 'b', label: '乙', hint: '说明', onSelect: vi.fn(), ...over.b },
  { id: 'c', label: '丙', danger: true, separatorBefore: true, onSelect: vi.fn(), ...over.c },
]

describe('ContextMenu', () => {
  it('右键目标才出菜单;菜单渲染到 body(不在目标的 DOM 子树里)', () => {
    render(<Harness items={items()} />)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('target'), { clientX: 30, clientY: 40 })
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    expect(menu.querySelector('[role="separator"]')).toBeTruthy()
  })

  it('点菜单项:先关菜单,再执行动作', () => {
    const list = items()
    render(<Harness items={list} />)
    fireEvent.contextMenu(screen.getByTestId('target'))
    fireEvent.click(screen.getByRole('menuitem', { name: /乙/ }))
    expect(list[1].onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('禁用项点不动,且悬停提示原因', () => {
    const list = items({ c: { disabled: true, disabledReason: '至少保留一个' } })
    render(<Harness items={list} />)
    fireEvent.contextMenu(screen.getByTestId('target'))
    const disabled = screen.getByRole('menuitem', { name: /丙/ }) as HTMLButtonElement
    expect(disabled.disabled).toBe(true)
    expect(disabled.title).toBe('至少保留一个')
    fireEvent.click(disabled)
    expect(list[2].onSelect).not.toHaveBeenCalled()
  })

  it('打开后焦点落在第一个可用项;上下键循环移动并跳过禁用项', () => {
    render(<Harness items={items({ a: { disabled: true } })} />)
    fireEvent.contextMenu(screen.getByTestId('target'))
    const [, b, c] = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(c)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(c)
  })

  it('Esc / 点菜单外 / 窗口缩放 / 滚动 都会关闭', () => {
    render(<Harness items={items()} />)
    const open = () => fireEvent.contextMenu(screen.getByTestId('target'))

    open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    open()
    fireEvent.mouseDown(screen.getByTestId('other'))
    expect(screen.queryByRole('menu')).toBeNull()

    open()
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('menu')).toBeNull()

    open()
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('在菜单自己身上按下鼠标不会把它关掉', () => {
    render(<Harness items={items()} />)
    fireEvent.contextMenu(screen.getByTestId('target'))
    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('已开着菜单时在目标上再右键:换成新菜单,不是关掉', () => {
    render(<Harness items={items()} />)
    fireEvent.contextMenu(screen.getByTestId('target'))
    // 浏览器真实顺序:右键按下 mousedown(关旧的)→ contextmenu(开新的)
    fireEvent.mouseDown(screen.getByTestId('target'), { button: 2 })
    fireEvent.contextMenu(screen.getByTestId('target'))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
  })

  it('空条目不弹菜单', () => {
    render(<Harness items={[]} />)
    fireEvent.contextMenu(screen.getByTestId('target'))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
