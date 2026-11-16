// 剧栏拖拽排序:拖行左侧的把手,黄色插入线标出放下位置;置顶组不可跨;↑↓ 键也能挪。
// jsdom 没有真正的拖放,这里用 fireEvent + 假 dataTransfer 驱动 React 的 drag 事件。
import { act, cleanup, createEvent, fireEvent as rtlFireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY, RAIL_COLLAPSED_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { PROJECT_DRAG_MIME, ProjectRail } from '../ProjectRail'

const S = () => useVideoWorkbenchStore.getState()
const storedOrder = () =>
  S()
    .projects.slice()
    .sort((a, b) => a.order - b.order)
    .map((p) => p.name)

function makeDt() {
  const data: Record<string, string> = {}
  return {
    types: [] as string[],
    effectAllowed: '',
    dropEffect: '',
    setData(type: string, value: string) {
      data[type] = value
      if (!this.types.includes(type)) this.types.push(type)
    },
    getData: (type: string) => data[type] ?? '',
    setDragImage: vi.fn(),
  }
}

// jsdom 没有 DragEvent,RTL 退回成普通 Event,init 里的 clientY 会被丢掉 —— 手动补到事件上,
// 否则「鼠标在行的上半还是下半」永远读到 undefined。
type DragInit = { dataTransfer?: unknown; clientY?: number; relatedTarget?: EventTarget | null }
const dragFire = (type: 'dragOver' | 'drop', el: Element, init: DragInit) => {
  const ev = createEvent[type](el, init as never)
  if (init.clientY !== undefined) Object.defineProperty(ev, 'clientY', { value: init.clientY })
  return rtlFireEvent(el, ev)
}
const fireEvent = {
  ...rtlFireEvent,
  dragOver: (el: Element, init: DragInit) => dragFire('dragOver', el, init),
  drop: (el: Element, init: DragInit) => dragFire('drop', el, init),
}
const grip = (name: string) => screen.getByRole('button', { name: `拖动调整 ${name} 的位置` })
const rowOf = (name: string) =>
  screen.getByRole('button', { name: `切换到剧 ${name}` }).closest('[role="listitem"]') as HTMLElement
const rowNames = () => screen.getAllByRole('listitem').map((r) => r.querySelector('.vw-rail-name')?.textContent ?? '')

// 每一行高 40,中线 20:clientY < 20 = 上半(before),否则下半(after)
const UPPER = 10
const LOWER = 30

beforeEach(() => {
  localStorage.clear() // 置顶存在 localStorage,不清会把上一条用例的置顶带进来
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(RAIL_COLLAPSED_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const h = this.classList.contains('vw-rail-row') ? 40 : 0
    return { top: 0, bottom: h, left: 0, right: 0, width: 0, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
  S().addProject('追车戏')
  S().addProject('夜景')
  S().switchProject('project-default')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ProjectRail 拖拽排序', () => {
  it('每行一个把手;搜索过滤中、折叠态都不给(子集里的「前后」没有明确含义)', () => {
    render(<ProjectRail />)
    expect(screen.getAllByRole('button', { name: /^拖动调整 .* 的位置$/ })).toHaveLength(3)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索剧' }), { target: { value: '追车' } })
    expect(screen.queryAllByRole('button', { name: /^拖动调整 / })).toHaveLength(0)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索剧' }), { target: { value: '' } })
    expect(screen.getAllByRole('button', { name: /^拖动调整 / })).toHaveLength(3)
    act(() => S().setRailCollapsed(true))
    expect(screen.queryAllByRole('button', { name: /^拖动调整 / })).toHaveLength(0)
  })

  it('拖把手到另一行的下半 → 放到它后面;悬停时那行画下沿插入线,放下后清掉', () => {
    render(<ProjectRail />)
    expect(storedOrder()).toEqual(['默认项目', '追车戏', '夜景'])
    const dt = makeDt()
    fireEvent.dragStart(grip('默认项目'), { dataTransfer: dt })
    expect(dt.types).toContain(PROJECT_DRAG_MIME)
    expect(dt.getData(PROJECT_DRAG_MIME)).toBe('project-default')
    // 拖影是整行,不是 10px 的把手
    expect(dt.setDragImage).toHaveBeenCalledTimes(1)
    expect((dt.setDragImage.mock.calls[0] as unknown[])[0]).toBe(rowOf('默认项目'))

    // 返回 false = 处理器 preventDefault 了 = 这里可以放
    expect(fireEvent.dragOver(rowOf('夜景'), { dataTransfer: dt, clientY: LOWER })).toBe(false)
    expect(dt.dropEffect).toBe('move')
    expect(rowOf('夜景').className).toContain('vw-rail-drop-after')
    expect(rowOf('夜景').className).not.toContain('vw-rail-drop-before')

    fireEvent.drop(rowOf('夜景'), { dataTransfer: dt, clientY: LOWER })
    expect(storedOrder()).toEqual(['追车戏', '夜景', '默认项目'])
    expect(rowNames().map((n) => n.replace(/PIN$/, ''))).toEqual(['追车戏', '夜景', '默认项目'])
    expect(document.querySelector('.vw-rail-drop-before, .vw-rail-drop-after')).toBeNull()
  })

  it('拖到另一行的上半 → 放到它前面,画上沿插入线', () => {
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('夜景'), { dataTransfer: dt })
    expect(fireEvent.dragOver(rowOf('默认项目'), { dataTransfer: dt, clientY: UPPER })).toBe(false)
    expect(rowOf('默认项目').className).toContain('vw-rail-drop-before')
    fireEvent.drop(rowOf('默认项目'), { dataTransfer: dt, clientY: UPPER })
    expect(storedOrder()).toEqual(['夜景', '默认项目', '追车戏'])
  })

  it('同一行内上下半之间移动鼠标:插入线跟着换边', () => {
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('默认项目'), { dataTransfer: dt })
    fireEvent.dragOver(rowOf('夜景'), { dataTransfer: dt, clientY: LOWER })
    expect(rowOf('夜景').className).toContain('vw-rail-drop-after')
    fireEvent.dragOver(rowOf('夜景'), { dataTransfer: dt, clientY: UPPER })
    expect(rowOf('夜景').className).toContain('vw-rail-drop-before')
    expect(rowOf('夜景').className).not.toContain('vw-rail-drop-after')
  })

  it('原行变暗要延后一拍(同步变暗会让浏览器截到暗的拖影),dragend 后复原', async () => {
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('追车戏'), { dataTransfer: dt })
    expect(rowOf('追车戏').className).not.toContain('vw-rail-row-dragging')
    await waitFor(() => expect(rowOf('追车戏').className).toContain('vw-rail-row-dragging'))
    fireEvent.dragEnd(grip('追车戏'), { dataTransfer: dt })
    expect(rowOf('追车戏').className).not.toContain('vw-rail-row-dragging')
  })

  it('不能放的地方不画线、不接收(光标显示禁止):自己 / 已经相邻', () => {
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('追车戏'), { dataTransfer: dt })
    // 放在自己身上
    expect(fireEvent.dragOver(rowOf('追车戏'), { dataTransfer: dt, clientY: LOWER })).toBe(true)
    expect(dt.dropEffect).toBe('none')
    // 追车戏本来就在夜景前面
    expect(fireEvent.dragOver(rowOf('夜景'), { dataTransfer: dt, clientY: UPPER })).toBe(true)
    expect(document.querySelector('.vw-rail-drop-before, .vw-rail-drop-after')).toBeNull()
    const revision = S().revision
    fireEvent.drop(rowOf('夜景'), { dataTransfer: dt, clientY: UPPER })
    expect(storedOrder()).toEqual(['默认项目', '追车戏', '夜景'])
    expect(S().revision).toBe(revision)
  })

  it('置顶的永远在最上:非置顶的不能拖进置顶组,置顶的也不能拖到非置顶组', () => {
    act(() => S().setProjectPinned(S().projects.find((p) => p.name === '夜景')!.id, true))
    render(<ProjectRail />)
    expect(rowNames()[0]).toContain('夜景')
    const dt = makeDt()
    fireEvent.dragStart(grip('默认项目'), { dataTransfer: dt })
    expect(fireEvent.dragOver(rowOf('夜景'), { dataTransfer: dt, clientY: LOWER })).toBe(true)
    expect(dt.dropEffect).toBe('none')
    fireEvent.drop(rowOf('夜景'), { dataTransfer: dt, clientY: LOWER })
    fireEvent.dragEnd(grip('默认项目'), { dataTransfer: dt })

    const dt2 = makeDt()
    fireEvent.dragStart(grip('夜景'), { dataTransfer: dt2 })
    expect(fireEvent.dragOver(rowOf('追车戏'), { dataTransfer: dt2, clientY: LOWER })).toBe(true)
    fireEvent.drop(rowOf('追车戏'), { dataTransfer: dt2, clientY: LOWER })
    expect(storedOrder()).toEqual(['默认项目', '追车戏', '夜景'])
  })

  it('置顶组之外的重排不动置顶项的存储位置;取消置顶后各回各位', () => {
    const night = S().projects.find((p) => p.name === '夜景')!.id
    act(() => S().setProjectPinned(night, true))
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('追车戏'), { dataTransfer: dt })
    fireEvent.dragOver(rowOf('默认项目'), { dataTransfer: dt, clientY: UPPER })
    fireEvent.drop(rowOf('默认项目'), { dataTransfer: dt, clientY: UPPER })
    // 显示 夜景(置顶) 追车戏 默认项目;存储里夜景仍排最后
    expect(storedOrder()).toEqual(['追车戏', '默认项目', '夜景'])
    act(() => S().setProjectPinned(night, false))
    expect(rowNames().map((n) => n.replace(/PIN$/, ''))).toEqual(['追车戏', '默认项目', '夜景'])
  })

  it('拖剧时不会冒出「新建一部剧并移入」投放框(那是分段卡专用的)', () => {
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('追车戏'), { dataTransfer: dt })
    fireEvent.dragEnter(screen.getByRole('list'), { dataTransfer: dt })
    expect(screen.queryByRole('button', { name: '放到这里:新建一部剧并移入' })).toBeNull()
  })

  it('不是从把手发起的拖放(没有 dragstart)被忽略;dragend 之后残留的 drop 也被忽略', () => {
    render(<ProjectRail />)
    const foreign = makeDt()
    foreign.setData(PROJECT_DRAG_MIME, 'project-default')
    expect(fireEvent.dragOver(rowOf('夜景'), { dataTransfer: foreign, clientY: LOWER })).toBe(true)
    fireEvent.drop(rowOf('夜景'), { dataTransfer: foreign, clientY: LOWER })
    expect(storedOrder()).toEqual(['默认项目', '追车戏', '夜景'])

    const dt = makeDt()
    fireEvent.dragStart(grip('默认项目'), { dataTransfer: dt })
    fireEvent.dragEnd(grip('默认项目'), { dataTransfer: dt })
    fireEvent.drop(rowOf('夜景'), { dataTransfer: dt, clientY: LOWER })
    expect(storedOrder()).toEqual(['默认项目', '追车戏', '夜景'])
  })

  it('拖出列表(离开)时插入线收起', () => {
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('默认项目'), { dataTransfer: dt })
    fireEvent.dragOver(rowOf('夜景'), { dataTransfer: dt, clientY: LOWER })
    expect(document.querySelector('.vw-rail-drop-after')).not.toBeNull()
    fireEvent.dragLeave(screen.getByRole('list'), { relatedTarget: document.body })
    expect(document.querySelector('.vw-rail-drop-after')).toBeNull()
  })

  it('点把手不会切剧(不触发行的点击)', () => {
    render(<ProjectRail />)
    fireEvent.click(grip('夜景'))
    expect(S().activeProjectId).toBe('project-default')
  })
})

describe('ProjectRail 键盘排序', () => {
  it('把手上 ↓ 下移一格、↑ 上移一格,焦点留在被挪的那个把手上(可以连按)', () => {
    render(<ProjectRail />)
    grip('追车戏').focus()
    fireEvent.keyDown(grip('追车戏'), { key: 'ArrowDown' })
    expect(storedOrder()).toEqual(['默认项目', '夜景', '追车戏'])
    expect(document.activeElement).toBe(grip('追车戏'))
    fireEvent.keyDown(grip('追车戏'), { key: 'ArrowUp' })
    fireEvent.keyDown(grip('追车戏'), { key: 'ArrowUp' })
    expect(storedOrder()).toEqual(['追车戏', '默认项目', '夜景'])
    expect(document.activeElement).toBe(grip('追车戏'))
  })
  it('到头了不动;其他按键不处理', () => {
    render(<ProjectRail />)
    const revision = S().revision
    fireEvent.keyDown(grip('默认项目'), { key: 'ArrowUp' })
    fireEvent.keyDown(grip('夜景'), { key: 'ArrowDown' })
    fireEvent.keyDown(grip('追车戏'), { key: 'Enter' })
    expect(storedOrder()).toEqual(['默认项目', '追车戏', '夜景'])
    expect(S().revision).toBe(revision)
  })

  it('撞到置顶分组边界时不动', () => {
    act(() => S().setProjectPinned(S().projects.find((p) => p.name === '夜景')!.id, true))
    render(<ProjectRail />)
    // 显示:夜景(置顶) 默认项目 追车戏;默认项目 ↑ 会越过置顶边界
    const revision = S().revision
    fireEvent.keyDown(grip('默认项目'), { key: 'ArrowUp' })
    expect(S().revision).toBe(revision)
    expect(storedOrder()).toEqual(['默认项目', '追车戏', '夜景'])
  })
})
