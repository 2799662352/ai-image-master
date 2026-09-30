import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PetOverlay } from '../pets/PetOverlay'
import { PetPickerButton } from '../pets/PetPickerButton'
import {
  PET_ANIMATIONS,
  PET_POSITION_STORAGE_KEY,
  PET_STORAGE_KEY,
  loadPetSelection,
  lookFrameForVector,
} from '../pets/petAnimations'
import { usePetStore } from '../pets/petStore'
import { useAgentChatStore } from '../store'
import type { PetsListCustomResult } from '../../../../../types/pets'

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
  delete (window as { electronAPI?: unknown }).electronAPI
})

beforeEach(() => {
  localStorage.clear()
  usePetStore.setState({
    petId: null,
    pickerOpen: false,
    customPets: [],
    customPetsDir: null,
    customPetsLoaded: false,
  })
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

  it('存下的位置在视口外(窗口变小后):显示上拉回可见区域,不改写存储', () => {
    const saved = JSON.stringify({ x: -903, y: -125 })
    localStorage.setItem(PET_POSITION_STORAGE_KEY, saved)
    // 按 transform 算出的真实位置:x 偏移 -903 时左边缘落在 -200
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('data-testid') !== 'agent-pet-body') return new DOMRect(0, 0, 0, 0)
      const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(this.style.transform)
      const x = m ? Number(m[1]) : 0
      const y = m ? Number(m[2]) : 0
      return new DOMRect(703 + x, 400 + y, 96, 104)
    })
    usePetStore.setState({ petId: 'doro' })
    render(<PetOverlay />)
    expect(screen.getByTestId('agent-pet-body').style.transform).toBe('translate(-703px, -125px)')
    expect(localStorage.getItem(PET_POSITION_STORAGE_KEY)).toBe(saved)
  })

  it('重新挂载恢复上次拖放的位置', () => {
    localStorage.setItem(PET_POSITION_STORAGE_KEY, JSON.stringify({ x: 12, y: -40 }))
    usePetStore.setState({ petId: 'doro' })
    render(<PetOverlay />)
    expect(screen.getByTestId('agent-pet-body').style.transform).toBe('translate(12px, -40px)')
  })

  it('工具栏按钮:只有图标,宠物名在 aria-label 里,点击开/关选择器', () => {
    render(
      <>
        <PetPickerButton />
        <PetOverlay />
      </>,
    )
    const button = screen.getByTestId('agent-pet-picker-button')
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-label')).toBe('宠物：宠物')

    fireEvent.click(button)
    expect(screen.getByTestId('agent-pet-picker')).toBeTruthy()
    fireEvent.click(button)
    expect(screen.queryByTestId('agent-pet-picker')).toBeNull()

    fireEvent.click(button)
    fireEvent.click(screen.getByTestId('agent-pet-row-doro'))
    expect(screen.getByTestId('agent-pet-picker-button').getAttribute('aria-label')).toBe('宠物：Doro')
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

describe('自装宠物(<CODEX_HOME>/pets)', () => {
  const MIKU_SCAN: PetsListCustomResult = {
    ok: true,
    dir: 'C:\\Users\\me\\.codex\\pets',
    pets: [
      {
        folder: 'greenbyte-miku',
        displayName: 'Greenbyte Miku',
        spriteVersion: 2,
        spritesheetPath: 'C:\\Users\\me\\.codex\\pets\\greenbyte-miku\\spritesheet.webp',
      },
    ],
    skipped: [],
  }

  function mockPetsApi(result: PetsListCustomResult = MIKU_SCAN) {
    const api = { listCustom: vi.fn(async () => result), openFolder: vi.fn(async () => ({ ok: true })) }
    ;(window as { electronAPI?: unknown }).electronAPI = { pets: api }
    return api
  }

  it('打开选择器时扫描目录,自装宠物排在内置宠物后面并带「自装」标记', async () => {
    const api = mockPetsApi()
    render(<PetOverlay />)
    await act(async () => usePetStore.getState().openPicker())
    expect(api.listCustom).toHaveBeenCalledTimes(1)
    const row = screen.getByTestId('agent-pet-row-custom:greenbyte-miku')
    expect(row.textContent).toContain('Greenbyte Miku')
    expect(row.textContent).toContain('自装')
    const rows = Array.from(screen.getByTestId('agent-pet-picker').querySelectorAll('[data-testid^="agent-pet-row-"]'))
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'agent-pet-row-off',
      'agent-pet-row-gugugaga',
      'agent-pet-row-doro',
      'agent-pet-row-greenbyte-miku',
      'agent-pet-row-pinkbyte-miku',
      'agent-pet-row-bluebyte-miku',
      'agent-pet-row-custom:greenbyte-miku',
    ])
  })

  it('选中 V2 自装宠物:local-file 图集、按 11 行切图、持久化 custom: id', async () => {
    mockPetsApi()
    render(<PetOverlay />)
    await act(async () => usePetStore.getState().openPicker())
    fireEvent.click(screen.getByTestId('agent-pet-row-custom:greenbyte-miku'))

    const sprite = screen.getByTestId('agent-pet-sprite')
    expect(sprite.style.backgroundImage).toContain(
      'local-file:///C:/Users/me/.codex/pets/greenbyte-miku/spritesheet.webp',
    )
    // 0.5 缩放:8 列 x 96px,11 行 x 104px
    expect(sprite.style.backgroundSize).toBe('768px 1144px')
    expect(localStorage.getItem(PET_STORAGE_KEY)).toBe('custom:greenbyte-miku')
  })

  it('内置 Pixel Miku:V2 按 11 行切图,idle 播满实测的 7 帧', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.99) // 待机小动作推到 ~10s 后,不干扰计帧
    usePetStore.setState({ petId: 'pinkbyte-miku' })
    render(<PetOverlay />)
    const sprite = () => screen.getByTestId('agent-pet-sprite')
    expect(sprite().style.backgroundImage).toContain('./pets/pinkbyte-miku/spritesheet.webp')
    expect(sprite().style.backgroundSize).toBe('768px 1144px')
    const cols = new Set<string>()
    for (let i = 0; i < 8; i++) {
      cols.add(sprite().style.backgroundPosition)
      act(() => vi.advanceTimersByTime(125))
    }
    expect(cols.size).toBe(7)
  })

  it('内置 V1 宠物仍按 9 行切图', () => {
    usePetStore.setState({ petId: 'doro' })
    render(<PetOverlay />)
    expect(screen.getByTestId('agent-pet-sprite').style.backgroundSize).toBe('768px 936px')
  })

  it('上次选的是自装宠物:启动时扫描目录后恢复', async () => {
    localStorage.setItem(PET_STORAGE_KEY, 'custom:greenbyte-miku')
    expect(loadPetSelection()).toBe('custom:greenbyte-miku')
    const api = mockPetsApi()
    usePetStore.setState({ petId: 'custom:greenbyte-miku' })
    render(<PetOverlay />)
    await act(async () => {})
    expect(api.listCustom).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('agent-pet-sprite').style.backgroundImage).toContain('greenbyte-miku')
  })

  it('自装宠物已被删掉:不渲染精灵', async () => {
    mockPetsApi({ ...MIKU_SCAN, pets: [] })
    usePetStore.setState({ petId: 'custom:greenbyte-miku' })
    render(<PetOverlay />)
    await act(async () => {})
    expect(screen.queryByTestId('agent-pet-sprite')).toBeNull()
  })

  it('「打开宠物文件夹」调用主进程', async () => {
    const api = mockPetsApi()
    render(<PetOverlay />)
    await act(async () => usePetStore.getState().openPicker())
    fireEvent.click(screen.getByTestId('agent-pet-open-folder'))
    expect(api.openFolder).toHaveBeenCalledTimes(1)
  })
})

describe('V2 视线方向', () => {
  it('lookFrameForVector:0° 正上方起顺时针,16 格分在第 9、10 行', () => {
    expect(lookFrameForVector(0, -10)).toEqual({ row: 9, col: 0 }) // 上
    expect(lookFrameForVector(10, -10)).toEqual({ row: 9, col: 2 }) // 右上 45°
    expect(lookFrameForVector(10, 0)).toEqual({ row: 9, col: 4 }) // 右
    expect(lookFrameForVector(0, 10)).toEqual({ row: 10, col: 0 }) // 下
    expect(lookFrameForVector(-10, 0)).toEqual({ row: 10, col: 4 }) // 左
    expect(lookFrameForVector(-1, -100)).toEqual({ row: 9, col: 0 }) // 接近 360° 回到上
    expect(lookFrameForVector(0, 0)).toBeNull()
  })

  function selectMiku() {
    usePetStore.setState({
      petId: 'custom:greenbyte-miku',
      customPetsLoaded: true,
      customPets: [
        {
          id: 'custom:greenbyte-miku',
          displayName: 'Greenbyte Miku',
          spritesheetPath: 'local-file:///C:/pets/greenbyte-miku/spritesheet.webp',
          spriteVersion: 2,
          custom: true,
        },
      ],
    })
  }

  it('idle 时看向鼠标,鼠标停下 2.5s 回到 idle 动画', () => {
    vi.useFakeTimers()
    selectMiku()
    render(<PetOverlay />)
    const sprite = () => screen.getByTestId('agent-pet-sprite')

    // jsdom rect 全 0 → 精灵中心在 (0,0);指针在正右方
    fireEvent.pointerMove(window, { clientX: 300, clientY: 0 })
    expect(sprite().getAttribute('data-pet-look')).toBe('9:4')
    expect(sprite().style.backgroundPosition).toBe(`-${4 * 96}px -${9 * 104}px`)

    act(() => vi.advanceTimersByTime(2500))
    expect(sprite().getAttribute('data-pet-look')).toBeNull()
    expect(sprite().getAttribute('data-pet-state')).toBe('idle')
  })

  it('死区内不转头;agent 干活时不看鼠标', () => {
    selectMiku()
    render(<PetOverlay />)
    fireEvent.pointerMove(window, { clientX: 10, clientY: 10 })
    expect(screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-look')).toBeNull()

    act(() => useAgentChatStore.setState({ isRunning: true }))
    fireEvent.pointerMove(window, { clientX: 300, clientY: 0 })
    const sprite = screen.getByTestId('agent-pet-sprite')
    expect(sprite.getAttribute('data-pet-look')).toBeNull()
    expect(sprite.getAttribute('data-pet-state')).toBe('running')
  })

  it('V1 宠物不响应鼠标', () => {
    usePetStore.setState({ petId: 'doro' })
    render(<PetOverlay />)
    fireEvent.pointerMove(window, { clientX: 300, clientY: 0 })
    expect(screen.getByTestId('agent-pet-sprite').getAttribute('data-pet-look')).toBeNull()
  })
})
