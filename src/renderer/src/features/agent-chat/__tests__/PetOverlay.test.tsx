import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PetOverlay } from '../pets/PetOverlay'
import { PetPickerButton } from '../pets/PetPickerButton'
import {
  PET_ANIMATIONS,
  PET_POSITION_STORAGE_KEY,
  PET_STORAGE_KEY,
} from '../pets/petAnimations'
import { usePetStore } from '../pets/petStore'
import { useAgentChatStore } from '../store'

/**
 * 环境宠物(对齐官方 Codex pets,openai/codex#21206):
 *  - 入口是 `/pets` 选择器(petStore.openPicker),没有独立按钮;
 *  - 选择器首行「关闭宠物」(官方 Disable pets)+ 内置宠物 + 预览面板;
 *  - 精灵状态跟随 store:running / waiting(批准)/ failed(错误)/ idle;
 *  - 选择持久化 localStorage。
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

beforeEach(() => {
  localStorage.clear()
  usePetStore.setState({ petId: null, pickerOpen: false })
  useAgentChatStore.setState({
    isRunning: false,
    pendingApprovals: [],
    error: undefined,
  })
})

describe('PetOverlay', () => {
  it('默认关闭:不渲染精灵,也没有任何按钮', () => {
    const { container } = render(<PetOverlay />)
    expect(screen.queryByTestId('agent-pet-sprite')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('/pets 打开选择器:首行是「关闭宠物」,列出内置宠物和预览面板', () => {
    render(<PetOverlay />)
    act(() => usePetStore.getState().openPicker())
    const picker = screen.getByTestId('agent-pet-picker')
    const rows = picker.querySelectorAll('button')
    expect(rows[0].textContent).toContain('关闭宠物')
    expect(screen.getByTestId('agent-pet-row-gugugaga').textContent).toContain('咕咕嘎嘎')
    expect(screen.getByTestId('agent-pet-row-doro').textContent).toContain('Doro')
    expect(screen.getByTestId('agent-pet-preview')).toBeTruthy()
  })

  it('选择器点「咕咕嘎嘎」后渲染精灵、关闭选择器并持久化', () => {
    render(<PetOverlay />)
    act(() => usePetStore.getState().openPicker())
    fireEvent.click(screen.getByTestId('agent-pet-row-gugugaga'))
    expect(screen.getByTestId('agent-pet-sprite')).toBeTruthy()
    expect(screen.queryByTestId('agent-pet-picker')).toBeNull()
    expect(localStorage.getItem(PET_STORAGE_KEY)).toBe('gugugaga')
  })

  it('记住上次选择(Doro),重新挂载直接出现', () => {
    usePetStore.setState({ petId: 'doro' })
    render(<PetOverlay />)
    const sprite = screen.getByTestId('agent-pet-sprite')
    expect(sprite.style.backgroundImage).toContain('doro')
  })

  it('键盘 ↓ + Enter 选中第一只宠物,Esc 关闭选择器', () => {
    render(<PetOverlay />)
    act(() => usePetStore.getState().openPicker())
    const picker = screen.getByTestId('agent-pet-picker')
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(usePetStore.getState().petId).toBe('gugugaga')
    act(() => usePetStore.getState().openPicker())
    fireEvent.keyDown(screen.getByTestId('agent-pet-picker'), { key: 'Escape' })
    expect(screen.queryByTestId('agent-pet-picker')).toBeNull()
  })

  it('agent 运行中精灵切到 running 行', () => {
    usePetStore.setState({ petId: 'gugugaga' })
    render(<PetOverlay />)
    act(() => useAgentChatStore.setState({ isRunning: true }))
    const sprite = screen.getByTestId('agent-pet-sprite')
    expect(sprite.getAttribute('data-pet-state')).toBe('running')
    const row = PET_ANIMATIONS.running.row
    expect(sprite.style.backgroundPosition).toContain(`-${row * 208 * 0.5}px`)
  })

  it('有待批准时显示 waiting;出错显示 failed(优先级高于 waiting)', () => {
    usePetStore.setState({ petId: 'gugugaga' })
    render(<PetOverlay />)
    act(() =>
      useAgentChatStore.setState({
        pendingApprovals: [{ id: 'a1' } as never],
      }),
    )
    expect(screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-state')).toBe('waiting')
    act(() => useAgentChatStore.setState({ error: 'boom' }))
    expect(screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-state')).toBe('failed')
  })

  it('宠物可抓取:拖动位移精灵、拖动中播 jumping、松手持久化位置', () => {
    usePetStore.setState({ petId: 'gugugaga' })
    render(<PetOverlay />)
    const body = screen.getByTestId('agent-pet-body')

    fireEvent.pointerDown(body, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(body, { clientX: 60, clientY: 130 })
    // 拖动中:被拎起来(jumping)
    expect(screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-state')).toBe('jumping')
    fireEvent.pointerUp(body)

    // jsdom 中 rect 全 0 → 向左钳到 0,向下(+30px)生效
    expect(body.style.transform).toBe('translate(0px, 30px)')
    const saved = JSON.parse(localStorage.getItem(PET_POSITION_STORAGE_KEY) ?? '{}')
    expect(saved).toEqual({ x: 0, y: 30 })
    // 松手后回到 store 驱动的状态
    expect(screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-state')).toBe('idle')
  })

  it('待机彩蛋:空闲时轮播 挥手→左散步→跳→右散步,做完回 idle', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0) // 间隔固定 5s,轮播确定性
    usePetStore.setState({ petId: 'gugugaga' })
    render(<PetOverlay />)
    const petState = () => screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-state')

    expect(petState()).toBe('idle')
    act(() => vi.advanceTimersByTime(5000))
    expect(petState()).toBe('waving')
    act(() => vi.advanceTimersByTime(2000))
    expect(petState()).toBe('idle')

    act(() => vi.advanceTimersByTime(5000))
    expect(petState()).toBe('running-left') // stroll-left 用 running-left 行
    // jsdom rect 全 0 → 首个 50ms tick 判定贴边,提前收工回 idle
    act(() => vi.advanceTimersByTime(50))
    expect(petState()).toBe('idle')

    act(() => vi.advanceTimersByTime(5000))
    expect(petState()).toBe('jumping')
    act(() => vi.advanceTimersByTime(1400))
    expect(petState()).toBe('idle')

    act(() => vi.advanceTimersByTime(5000))
    expect(petState()).toBe('running-right')
  })

  it('待机小动作被 agent 状态立即打断', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    usePetStore.setState({ petId: 'gugugaga' })
    render(<PetOverlay />)
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-state')).toBe('waving')
    act(() => useAgentChatStore.setState({ isRunning: true }))
    expect(screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-state')).toBe('running')
  })

  it('重新挂载恢复上次拖放的位置', () => {
    localStorage.setItem(PET_POSITION_STORAGE_KEY, JSON.stringify({ x: 12, y: -40 }))
    usePetStore.setState({ petId: 'doro' })
    render(<PetOverlay />)
    expect(screen.getByTestId('agent-pet-body').style.transform).toBe('translate(12px, -40px)')
  })

  it('工具栏按钮:未选宠物显示「宠物」,点击开/关选择器,选中后显示宠物名', () => {
    render(
      <>
        <PetPickerButton />
        <PetOverlay />
      </>,
    )
    const button = screen.getByTestId('agent-pet-picker-button')
    expect(button.textContent).toContain('宠物')

    fireEvent.click(button)
    expect(screen.getByTestId('agent-pet-picker')).toBeTruthy()
    fireEvent.click(button)
    expect(screen.queryByTestId('agent-pet-picker')).toBeNull()

    fireEvent.click(button)
    fireEvent.click(screen.getByTestId('agent-pet-row-doro'))
    expect(screen.getByTestId('agent-pet-picker-button').textContent).toContain('Doro')
  })

  it('点击选择器外部关闭(与邻位 picker 行为一致)', () => {
    render(<PetOverlay />)
    act(() => usePetStore.getState().openPicker())
    expect(screen.getByTestId('agent-pet-picker')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('agent-pet-picker')).toBeNull()
  })

  it('选择器首行「关闭宠物」:精灵消失并记住 off', () => {
    usePetStore.setState({ petId: 'gugugaga' })
    render(<PetOverlay />)
    expect(screen.getByTestId('agent-pet-sprite')).toBeTruthy()
    act(() => usePetStore.getState().openPicker())
    fireEvent.click(screen.getByTestId('agent-pet-row-off'))
    expect(screen.queryByTestId('agent-pet-sprite')).toBeNull()
    expect(localStorage.getItem(PET_STORAGE_KEY)).toBe('off')
  })
})
