// 总览分段网格拖拽排序:拖卡到另一张卡的左半 / 右半 = 插到它前 / 后,黄色竖线标出落点;
// 置顶组不可跨;「新建分段」格 = 放到最后;拖到剧栏(移到别的剧)的老行为不受影响。
// jsdom 没有真正的拖放,这里用 fireEvent + 假 dataTransfer 驱动 React 的 drag 事件。
import { act, cleanup, createEvent, fireEvent as rtlFireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { PROJECT_DRAG_MIME } from '../ProjectRail'
import { ProjectOverview, SEGMENT_DRAG_MIME } from '../ProjectOverview'

const S = () => useVideoWorkbenchStore.getState()
const storedOrder = (projectId = S().activeProjectId) =>
  S()
    .boards.filter((b) => b.projectId === projectId)
    .sort((a, b) => a.order - b.order)
    .map((b) => b.name)

function makeDt(initialTypes: string[] = []) {
  const data: Record<string, string> = {}
  return {
    types: [...initialTypes] as string[],
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

// jsdom 没有 DragEvent,RTL 退回成普通 Event,init 里的 clientX 会被丢掉 —— 手动补到事件上,
// 否则「鼠标在卡的左半还是右半」永远读到 undefined。
type DragInit = { dataTransfer?: unknown; clientX?: number; relatedTarget?: EventTarget | null }
const dragFire = (type: 'dragOver' | 'drop' | 'dragLeave', el: Element, init: DragInit) => {
  const ev = createEvent[type](el, init as never)
  if (init.clientX !== undefined) Object.defineProperty(ev, 'clientX', { value: init.clientX })
  if (init.relatedTarget !== undefined) Object.defineProperty(ev, 'relatedTarget', { value: init.relatedTarget })
  return rtlFireEvent(el, ev)
}
const fireEvent = {
  ...rtlFireEvent,
  dragOver: (el: Element, init: DragInit) => dragFire('dragOver', el, init),
  drop: (el: Element, init: DragInit) => dragFire('drop', el, init),
  dragLeave: (el: Element, init: DragInit) => dragFire('dragLeave', el, init),
}

const card = (name: string) => screen.getByRole('button', { name: `打开分段 ${name}` })
const wrapOf = (name: string) => card(name).closest('.vw-seg-wrap') as HTMLElement
const tile = () => screen.getByRole('button', { name: '新建分段(网格)' })
const shownNames = () =>
  screen.getAllByRole('button', { name: /^打开分段 / }).map((el) => el.getAttribute('aria-label')?.replace('打开分段 ', ''))
const mark = () => document.querySelector('.vw-seg-drop-before, .vw-seg-drop-after')

// 每张卡宽 100,中线 50:clientX < 50 = 左半(before),否则右半(after)
const LEFT = 20
const RIGHT = 80

/** 一部有三段的剧「追车戏」(分段 1 / 隧道 / 天台),停在总览;另有一部「夜景」备着移动用。 */
function seed() {
  S().addProject('追车戏')
  S().addBoard('隧道')
  S().addBoard('天台')
  S().addProject('夜景')
  S().switchProject(S().projects.find((p) => p.name === '追车戏')!.id)
  S().openOverview()
}

beforeEach(() => {
  localStorage.clear() // 置顶存在 localStorage,不清会把上一条用例的置顶带进来
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const w = this.classList.contains('vw-seg-wrap') ? 100 : 0
    return { top: 0, bottom: 0, left: 0, right: w, width: w, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ProjectOverview 分段拖拽排序', () => {
  it('拖卡到另一张卡的右半 → 放到它后面;悬停时画右侧竖线,放下后清掉', () => {
    seed()
    render(<ProjectOverview />)
    expect(shownNames()).toEqual(['分段 1', '隧道', '天台'])
    const dt = makeDt()
    fireEvent.dragStart(card('分段 1'), { dataTransfer: dt })
    // 返回 false = 处理器 preventDefault 了 = 这里可以放
    expect(fireEvent.dragOver(card('隧道'), { dataTransfer: dt, clientX: RIGHT })).toBe(false)
    expect(dt.dropEffect).toBe('move')
    expect(wrapOf('隧道').className).toContain('vw-seg-drop-after')
    expect(wrapOf('隧道').className).not.toContain('vw-seg-drop-before')

    fireEvent.drop(card('隧道'), { dataTransfer: dt, clientX: RIGHT })
    expect(storedOrder()).toEqual(['隧道', '分段 1', '天台'])
    expect(shownNames()).toEqual(['隧道', '分段 1', '天台'])
    expect(mark()).toBeNull()
  })

  it('拖到另一张卡的左半 → 放到它前面,画左侧竖线', () => {
    seed()
    render(<ProjectOverview />)
    const dt = makeDt()
    fireEvent.dragStart(card('天台'), { dataTransfer: dt })
    expect(fireEvent.dragOver(card('分段 1'), { dataTransfer: dt, clientX: LEFT })).toBe(false)
    expect(wrapOf('分段 1').className).toContain('vw-seg-drop-before')
    fireEvent.drop(card('分段 1'), { dataTransfer: dt, clientX: LEFT })
    expect(storedOrder()).toEqual(['天台', '分段 1', '隧道'])
  })

  it('同一张卡内左右半之间移动鼠标:竖线跟着换边;换到别的卡:旧卡的线收掉', () => {
    seed()
    render(<ProjectOverview />)
    const dt = makeDt()
    fireEvent.dragStart(card('分段 1'), { dataTransfer: dt })
    fireEvent.dragOver(card('天台'), { dataTransfer: dt, clientX: RIGHT })
    expect(wrapOf('天台').className).toContain('vw-seg-drop-after')
    fireEvent.dragOver(card('天台'), { dataTransfer: dt, clientX: LEFT })
    expect(wrapOf('天台').className).toContain('vw-seg-drop-before')
    expect(wrapOf('天台').className).not.toContain('vw-seg-drop-after')
    fireEvent.dragOver(card('隧道'), { dataTransfer: dt, clientX: RIGHT })
    expect(wrapOf('天台').className).not.toMatch(/vw-seg-drop-/)
    expect(document.querySelectorAll('.vw-seg-drop-before, .vw-seg-drop-after')).toHaveLength(1)
  })

  it('拖影不暗:dragstart 当下不变暗,下一拍才暗;dragend 恢复并收掉竖线', async () => {
    seed()
    render(<ProjectOverview />)
    const dt = makeDt()
    fireEvent.dragStart(card('隧道'), { dataTransfer: dt })
    expect(wrapOf('隧道').className).not.toContain('vw-seg-dragging')
    await waitFor(() => expect(wrapOf('隧道').className).toContain('vw-seg-dragging'))
    fireEvent.dragOver(card('天台'), { dataTransfer: dt, clientX: RIGHT })
    expect(mark()).not.toBeNull()
    fireEvent.dragEnd(card('隧道'), { dataTransfer: dt })
    expect(wrapOf('隧道').className).not.toContain('vw-seg-dragging')
    expect(mark()).toBeNull()
    // 取消拖动(Esc)= 只有 dragend 没有 drop:顺序没动
    expect(storedOrder()).toEqual(['分段 1', '隧道', '天台'])
  })

  it('dragstart 仍带分段拖拽类型和 id(剧栏靠它认「这是一个分段」)', () => {
    seed()
    render(<ProjectOverview />)
    const dt = makeDt()
    fireEvent.dragStart(card('隧道'), { dataTransfer: dt })
    expect(dt.types).toContain(SEGMENT_DRAG_MIME)
    expect(dt.getData(SEGMENT_DRAG_MIME)).toBe(S().boards.find((b) => b.name === '隧道')!.id)
    expect(dt.effectAllowed).toBe('move')
  })

  it('放在原地不接收:放到自己右边紧邻 / 左边紧邻的那张卡上,光标禁止、没有竖线、顺序和版本都不动', () => {
    seed()
    render(<ProjectOverview />)
    const rev = S().revision
    const dt = makeDt()
    fireEvent.dragStart(card('隧道'), { dataTransfer: dt })
    // 隧道本就在 分段 1 后面 / 天台 前面
    expect(fireEvent.dragOver(card('分段 1'), { dataTransfer: dt, clientX: RIGHT })).toBe(true)
    expect(dt.dropEffect).toBe('none')
    expect(fireEvent.dragOver(card('天台'), { dataTransfer: dt, clientX: LEFT })).toBe(true)
    expect(fireEvent.dragOver(card('隧道'), { dataTransfer: dt, clientX: LEFT })).toBe(true) // 自己
    expect(mark()).toBeNull()
    fireEvent.drop(card('分段 1'), { dataTransfer: dt, clientX: RIGHT })
    expect(storedOrder()).toEqual(['分段 1', '隧道', '天台'])
    expect(S().revision).toBe(rev)
  })

  it('置顶的显示在最前,不能与未置顶的互换;但置顶组内部、未置顶组内部都能排', () => {
    seed()
    S().setBoardPinned(S().boards.find((b) => b.name === '隧道')!.id, true)
    render(<ProjectOverview />)
    // 存储顺序 [分段 1, 隧道, 天台],显示 [隧道, 分段 1, 天台]
    expect(shownNames()).toEqual(['隧道', '分段 1', '天台'])
    const dt = makeDt()
    // 未置顶的天台拖到置顶的隧道前面 → 不接收
    fireEvent.dragStart(card('天台'), { dataTransfer: dt })
    expect(fireEvent.dragOver(card('隧道'), { dataTransfer: dt, clientX: LEFT })).toBe(true)
    expect(dt.dropEffect).toBe('none')
    expect(mark()).toBeNull()
    fireEvent.drop(card('隧道'), { dataTransfer: dt, clientX: LEFT })
    expect(storedOrder()).toEqual(['分段 1', '隧道', '天台'])
    fireEvent.dragEnd(card('天台'), { dataTransfer: dt })

    // 未置顶组内部:分段 1 拖到天台后面 → 存储 [隧道, 天台, 分段 1]
    fireEvent.dragStart(card('分段 1'), { dataTransfer: dt })
    expect(fireEvent.dragOver(card('天台'), { dataTransfer: dt, clientX: RIGHT })).toBe(false)
    fireEvent.drop(card('天台'), { dataTransfer: dt, clientX: RIGHT })
    expect(storedOrder()).toEqual(['隧道', '天台', '分段 1'])
    expect(shownNames()).toEqual(['隧道', '天台', '分段 1'])
  })

  it('置顶组内部也能排:两张置顶的互换', () => {
    seed()
    S().setBoardPinned(S().boards.find((b) => b.name === '分段 1')!.id, true)
    S().setBoardPinned(S().boards.find((b) => b.name === '隧道')!.id, true)
    render(<ProjectOverview />)
    expect(shownNames()).toEqual(['分段 1', '隧道', '天台'])
    const dt = makeDt()
    fireEvent.dragStart(card('隧道'), { dataTransfer: dt })
    expect(fireEvent.dragOver(card('分段 1'), { dataTransfer: dt, clientX: LEFT })).toBe(false)
    fireEvent.drop(card('分段 1'), { dataTransfer: dt, clientX: LEFT })
    expect(shownNames()).toEqual(['隧道', '分段 1', '天台'])
  })

  it('拖到「新建分段」格 = 放到最后;已经在最后就不接收;点它仍是新建分段', () => {
    seed()
    render(<ProjectOverview />)
    const dt = makeDt()
    fireEvent.dragStart(card('分段 1'), { dataTransfer: dt })
    expect(fireEvent.dragOver(tile(), { dataTransfer: dt })).toBe(false)
    expect(dt.dropEffect).toBe('move')
    // 竖线画在最后一张卡的右侧
    expect(wrapOf('天台').className).toContain('vw-seg-drop-after')
    fireEvent.drop(tile(), { dataTransfer: dt })
    expect(storedOrder()).toEqual(['隧道', '天台', '分段 1'])
    fireEvent.dragEnd(card('分段 1'), { dataTransfer: dt })

    // 现在最后一张是 分段 1,再把它拖到格子上 = 原地
    fireEvent.dragStart(card('分段 1'), { dataTransfer: dt })
    expect(fireEvent.dragOver(tile(), { dataTransfer: dt })).toBe(true)
    expect(dt.dropEffect).toBe('none')
    expect(mark()).toBeNull()
    fireEvent.dragEnd(card('分段 1'), { dataTransfer: dt })

    const before = S().boards.length
    fireEvent.click(tile())
    expect(S().boards.length).toBe(before + 1)
  })

  it('不是我们的拖拽(剧栏的把手 / 外部文件)不接收:没有竖线、顺序不动', () => {
    seed()
    render(<ProjectOverview />)
    const rev = S().revision
    const foreign = makeDt([PROJECT_DRAG_MIME])
    expect(fireEvent.dragOver(card('隧道'), { dataTransfer: foreign, clientX: RIGHT })).toBe(true)
    expect(mark()).toBeNull()
    fireEvent.drop(card('隧道'), { dataTransfer: foreign, clientX: RIGHT })
    const files = makeDt(['Files'])
    expect(fireEvent.dragOver(card('天台'), { dataTransfer: files, clientX: RIGHT })).toBe(true)
    fireEvent.drop(card('天台'), { dataTransfer: files, clientX: RIGHT })
    expect(storedOrder()).toEqual(['分段 1', '隧道', '天台'])
    expect(S().revision).toBe(rev)

    // 就算手里有一张卡正拖着(记着被拖的 id),带着别的类型的拖拽也不能被当成分段排序
    const own = makeDt()
    fireEvent.dragStart(card('分段 1'), { dataTransfer: own })
    expect(fireEvent.dragOver(card('天台'), { dataTransfer: makeDt(['Files']), clientX: RIGHT })).toBe(true)
    expect(mark()).toBeNull()
    fireEvent.drop(card('天台'), { dataTransfer: makeDt(['Files']), clientX: RIGHT })
    expect(storedOrder()).toEqual(['分段 1', '隧道', '天台'])
  })

  it('指针移出整个网格才收竖线;在网格内部从一张卡移到另一张卡不收', () => {
    seed()
    render(<ProjectOverview />)
    const dt = makeDt()
    const grid = document.querySelector('.vw-seg-grid') as HTMLElement
    fireEvent.dragStart(card('分段 1'), { dataTransfer: dt })
    fireEvent.dragOver(card('隧道'), { dataTransfer: dt, clientX: RIGHT })
    expect(mark()).not.toBeNull()
    // 离开某张卡、进入网格里的另一张 → relatedTarget 仍在网格内
    fireEvent.dragLeave(grid, { dataTransfer: dt, relatedTarget: card('天台') })
    expect(mark()).not.toBeNull()
    // 真的离开了网格
    fireEvent.dragLeave(grid, { dataTransfer: dt, relatedTarget: document.body })
    expect(mark()).toBeNull()
  })

  it('卡被拖到剧栏移去别的剧(源卡卸载、收不到 dragend):残留的「正在拖」状态被清掉,卡以后回来不是暗的', async () => {
    seed()
    render(<ProjectOverview />)
    const here = S().activeProjectId
    const other = S().projects.find((p) => p.name === '夜景')!.id
    const tunnel = S().boards.find((b) => b.name === '隧道')!.id
    const dt = makeDt()
    fireEvent.dragStart(card('隧道'), { dataTransfer: dt })
    await waitFor(() => expect(wrapOf('隧道').className).toContain('vw-seg-dragging'))
    act(() => {
      expect(S().moveBoardToProject(tunnel, other)).toBe(true)
    })
    expect(shownNames()).toEqual(['分段 1', '天台'])
    // 没有 dragend —— 卡又回到这部剧
    act(() => {
      expect(S().moveBoardToProject(tunnel, here)).toBe(true)
    })
    expect(shownNames()).toContain('隧道')
    expect(wrapOf('隧道').className).not.toContain('vw-seg-dragging')
    expect(mark()).toBeNull()
  })
})
