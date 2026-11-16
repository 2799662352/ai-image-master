// 把分段卡拖到剧栏上:能放的那一行亮黄色虚线框 + 「移入此剧」;不能放的(自己所在的剧、源剧只剩一段)
// 光标禁止、不亮;拖动在剧栏之外结束(松手 / Esc)时高亮与投放框都收起。
// jsdom 没有真正的拖放,这里和 ProjectRail.reorder.test 一样用 fireEvent + 假 dataTransfer 驱动 React 的 drag 事件。
import { act, cleanup, createEvent, fireEvent as rtlFireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY, RAIL_COLLAPSED_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ProjectRail } from '../ProjectRail'
import { SEGMENT_DRAG_MIME } from '../ProjectOverview'

const S = () => useVideoWorkbenchStore.getState()

function makeDt(boardId: string) {
  const data: Record<string, string> = { [SEGMENT_DRAG_MIME]: boardId }
  return {
    types: [SEGMENT_DRAG_MIME] as string[],
    effectAllowed: 'move',
    dropEffect: '',
    getData: (type: string) => data[type] ?? '',
    setData: vi.fn(),
    setDragImage: vi.fn(),
  }
}

// jsdom 没有 DragEvent,RTL 退回成普通 Event,init 里的 relatedTarget 会被丢掉 —— 手动补上。
const withRelated = (type: 'dragLeave', el: Element, related: EventTarget | null) => {
  const ev = createEvent[type](el, {})
  Object.defineProperty(ev, 'relatedTarget', { value: related })
  return rtlFireEvent(el, ev)
}

const rowOf = (name: string) =>
  screen.getByRole('button', { name: `切换到剧 ${name}` }).closest('[role="listitem"]') as HTMLElement
const lit = () => Array.from(document.querySelectorAll('.vw-rail-row-segdrop')).map((r) => r.querySelector('.vw-rail-name')?.textContent)
const tips = () => screen.queryAllByText('移入此剧')

let boardId = ''

beforeEach(() => {
  localStorage.clear()
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(RAIL_COLLAPSED_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  // 默认项目有两个分段(才允许搬走一个),另有两部目标剧;当前停在默认项目
  S().addBoard('要搬的段')
  boardId = S().boards.find((b) => b.name === '要搬的段')!.id
  S().addProject('目标剧')
  S().addProject('另一部')
  S().switchProject('project-default')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('分段卡拖到剧栏:落点显示', () => {
  it('经过能放的行:亮虚线框 + 「移入此剧」,接收(preventDefault)、光标是移动', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    expect(lit()).toEqual([])
    // 事件从行按钮发起、冒泡到行 —— 与浏览器里指针落在行内任何地方一致
    const accepted = rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(accepted).toBe(false)
    expect(dt.dropEffect).toBe('move')
    expect(lit()).toEqual(['目标剧'])
    expect(rowOf('目标剧').className).toContain('vw-rail-row-segdrop')
    expect(tips()).toHaveLength(1)
    expect(rowOf('目标剧').contains(tips()[0])).toBe(true)
  })

  it('换到另一行:高亮跟着走,同一时刻只亮一行', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 另一部' }), { dataTransfer: dt })
    expect(lit()).toEqual(['另一部'])
    expect(tips()).toHaveLength(1)
  })

  it('经过自己所在的剧(当前剧):光标禁止、不亮、不接收 —— 列表级的 preventDefault 不能把它放行', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    const accepted = rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 默认项目' }), { dataTransfer: dt })
    expect(accepted).toBe(true)
    expect(dt.dropEffect).toBe('none')
    // 从「能放」滑到「不能放」:上一行的高亮收掉
    expect(lit()).toEqual([])
    expect(tips()).toHaveLength(0)
  })

  it('源剧只剩一段(搬走会空出来):所有行都禁止、不亮,也不露出「新建一部剧并移入」', () => {
    // 重来一份:默认项目只有出厂的那一段
    resetWorkbenchStoreForTest()
    resetWorkbenchDbForTest()
    S().addProject('目标剧')
    S().switchProject('project-default')
    expect(S().boards.filter((b) => b.projectId === 'project-default')).toHaveLength(1)
    render(<ProjectRail />)
    const dt = makeDt('any-board')
    const accepted = rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(accepted).toBe(true)
    expect(dt.dropEffect).toBe('none')
    expect(lit()).toEqual([])
    rtlFireEvent.dragEnter(screen.getByRole('list'), { dataTransfer: dt })
    expect(screen.queryByRole('button', { name: '放到这里:新建一部剧并移入' })).toBeNull()
    // 行外的空白也不接收
    const blank = rtlFireEvent.dragOver(screen.getByRole('list'), { dataTransfer: dt })
    expect(blank).toBe(true)
  })

  it('源剧有两段时,拖进来会露出顶部投放框;经过行外(投放框)时没有行亮着', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    rtlFireEvent.dragEnter(screen.getByRole('list'), { dataTransfer: dt })
    const zone = screen.getByRole('button', { name: '放到这里:新建一部剧并移入' })
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(lit()).toEqual(['目标剧'])
    rtlFireEvent.dragOver(zone, { dataTransfer: dt })
    expect(lit()).toEqual([])
  })

  it('离开这一行(指针去了行外)高亮收起;在行内的子元素之间移动不算离开', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    const btn = screen.getByRole('button', { name: '切换到剧 目标剧' })
    rtlFireEvent.dragOver(btn, { dataTransfer: dt })
    withRelated('dragLeave', btn, rowOf('目标剧').querySelector('.vw-rail-meta'))
    expect(lit()).toEqual(['目标剧'])
    withRelated('dragLeave', btn, document.body)
    expect(lit()).toEqual([])
  })

  it('从这一行直接滑到另一行(relatedTarget 在列表之内):这一行的高亮立刻收起,不等下一次 dragover', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    const btn = screen.getByRole('button', { name: '切换到剧 目标剧' })
    rtlFireEvent.dragOver(btn, { dataTransfer: dt })
    expect(lit()).toEqual(['目标剧'])
    // 列表级的 dragleave 只在「离开整个列表」时才收;这里要靠行自己的处理器
    withRelated('dragLeave', btn, rowOf('另一部'))
    expect(lit()).toEqual([])
  })

  it('经过分组标题:不接收、光标禁止,上一行的高亮收掉 —— 列表级的 preventDefault 不能把它放行', () => {
    act(() => void S().assignProjectGroup(S().projects.find((p) => p.name === '另一部')!.id, '外传'))
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(lit()).toEqual(['目标剧'])
    const accepted = rtlFireEvent.dragOver(screen.getByRole('button', { name: '折叠分组 外传' }), { dataTransfer: dt })
    expect(accepted).toBe(true)
    expect(dt.dropEffect).toBe('none')
    expect(lit()).toEqual([])
  })

  it('离开整个列表:高亮与投放框一起收起', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    rtlFireEvent.dragEnter(screen.getByRole('list'), { dataTransfer: dt })
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(screen.queryByRole('button', { name: '放到这里:新建一部剧并移入' })).not.toBeNull()
    withRelated('dragLeave', screen.getByRole('list'), document.body)
    expect(lit()).toEqual([])
    expect(screen.queryByRole('button', { name: '放到这里:新建一部剧并移入' })).toBeNull()
  })

  it('放在高亮的行上:分段搬进那部剧,高亮收起', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    const row = rowOf('目标剧')
    rtlFireEvent.dragOver(row, { dataTransfer: dt })
    expect(lit()).toEqual(['目标剧'])
    rtlFireEvent.drop(row, { dataTransfer: dt })
    expect(S().boards.find((b) => b.id === boardId)!.projectId).toBe(S().projects.find((p) => p.name === '目标剧')!.id)
    expect(lit()).toEqual([])
    expect(tips()).toHaveLength(0)
  })

  it('拖动在剧栏之外结束(源卡的 dragend / 别处的 drop):高亮与投放框不会卡在那儿', () => {
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    rtlFireEvent.dragEnter(screen.getByRole('list'), { dataTransfer: dt })
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(lit()).toEqual(['目标剧'])
    act(() => {
      document.body.dispatchEvent(new Event('dragend', { bubbles: true }))
    })
    expect(lit()).toEqual([])
    expect(screen.queryByRole('button', { name: '放到这里:新建一部剧并移入' })).toBeNull()

    // 另一路:松在剧栏之外的、愿意接收的地方 → window 收到冒泡上来的 drop
    rtlFireEvent.dragEnter(screen.getByRole('list'), { dataTransfer: dt })
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 另一部' }), { dataTransfer: dt })
    expect(lit()).toEqual(['另一部'])
    act(() => {
      document.body.dispatchEvent(new Event('drop', { bubbles: true }))
    })
    expect(lit()).toEqual([])
    expect(screen.queryByRole('button', { name: '放到这里:新建一部剧并移入' })).toBeNull()
  })

  it('折叠成 48px:照样亮虚线框,只是没有地方放「移入此剧」的字', () => {
    act(() => S().setRailCollapsed(true))
    render(<ProjectRail />)
    const dt = makeDt(boardId)
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(lit()).toHaveLength(1)
    expect(tips()).toHaveLength(0)
  })

  it('拖的是剧 / 分组(调顺序)时不会亮这个框:两种拖动互不串', () => {
    render(<ProjectRail />)
    const dt = {
      types: ['application/x-catimation-project'] as string[],
      getData: () => '',
      dropEffect: '',
      effectAllowed: '',
      setData: vi.fn(),
      setDragImage: vi.fn(),
    }
    rtlFireEvent.dragOver(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(lit()).toEqual([])
  })
})
