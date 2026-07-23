/**
 * 宠物层级适配:聊天面板 <aside> 自身是 z-[40000] + backdrop-blur 的
 * stacking context,且 DOM 顺序在 FileExplorerPanel(同 z-[40000])之前,
 * 宠物在 aside 内部无论 z 多大都会被工作区浮层盖住。因此 PetOverlay 用
 * createPortal 挂到 document.body,fixed 定位镜像原锚点位置,z 取 40001,
 * 保证工作区展示栏打开时宠物仍骑在最上层。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PetOverlay } from '../pets/PetOverlay'
import { usePetStore } from '../pets/petStore'
import { useAgentChatStore } from '../store'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  localStorage.clear()
  usePetStore.setState({ petId: null, pickerOpen: false })
  useAgentChatStore.setState({ isRunning: false, pendingApprovals: [], error: undefined })
})

describe('PetOverlay 层级(portal)', () => {
  it('宠物精灵 portal 到 document.body 顶层容器,而非留在挂载容器内', () => {
    usePetStore.setState({ petId: 'gugugaga' })
    const { container } = render(<PetOverlay />)

    const portalRoot = screen.getByTestId('agent-pet-overlay-root')
    // portal 容器必须是 document.body 的直接子节点,不在 render 容器里
    expect(portalRoot.parentElement).toBe(document.body)
    expect(container.contains(portalRoot)).toBe(false)
    // fixed + z-40001:高于工作区展示栏(z-[40000])
    expect(portalRoot.className).toContain('fixed')
    expect(portalRoot.className).toContain('z-[40001]')
    // 外层保持 pointer-events-none,不挡下层点击
    expect(portalRoot.className).toContain('pointer-events-none')
    // 精灵本体在 portal 容器内
    expect(portalRoot.contains(screen.getByTestId('agent-pet-body'))).toBe(true)
  })

  it('原挂载位置留下测量锚点(跟随 composer 定位)', () => {
    usePetStore.setState({ petId: 'gugugaga' })
    const { container } = render(<PetOverlay />)
    expect(container.querySelector('[data-testid="agent-pet-anchor"]')).toBeTruthy()
  })

  it('/pets 选择器同样渲染在 portal 顶层且可交互', () => {
    render(<PetOverlay />)
    act(() => usePetStore.getState().openPicker())
    const picker = screen.getByTestId('agent-pet-picker')
    const portalRoot = screen.getByTestId('agent-pet-overlay-root')
    expect(portalRoot.contains(picker)).toBe(true)
    fireEvent.click(screen.getByTestId('agent-pet-row-gugugaga'))
    expect(usePetStore.getState().petId).toBe('gugugaga')
  })

  it('无宠物且选择器关闭时不渲染任何 portal 节点', () => {
    render(<PetOverlay />)
    expect(screen.queryByTestId('agent-pet-overlay-root')).toBeNull()
    expect(screen.queryByTestId('agent-pet-anchor')).toBeNull()
  })

  it('宠物拖拽在 portal 下不回归:拖动位移并持久化', () => {
    usePetStore.setState({ petId: 'gugugaga' })
    render(<PetOverlay />)
    const body = screen.getByTestId('agent-pet-body')
    fireEvent.pointerDown(body, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(body, { clientX: 60, clientY: 130 })
    fireEvent.pointerUp(body)
    expect(body.style.transform).toBe('translate(0px, 30px)')
  })
})
