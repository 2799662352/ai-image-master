// 剧栏分组(文件夹):标题 / 折叠 / 计数与时长、拖动(进组 / 出组 / 整组挪动 / 底部空白)、键盘、菜单、搜索与折叠态。
// jsdom 没有真正的拖放,这里和 ProjectRail.reorder.test 一样用 fireEvent + 假 dataTransfer 驱动 React 的 drag 事件。
import { act, cleanup, createEvent, fireEvent as rtlFireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_PROJECT_KEY,
  COLLAPSED_GROUPS_KEY,
  EMPTY_GROUPS_KEY,
  RAIL_COLLAPSED_KEY,
} from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useToastStore } from '../../../stores/useToastStore'
import { GROUP_DRAG_MIME, PROJECT_DRAG_MIME, ProjectRail } from '../ProjectRail'
import { SEGMENT_DRAG_MIME } from '../ProjectOverview'

const S = () => useVideoWorkbenchStore.getState()
const idOf = (name: string) => S().projects.find((p) => p.name === name)!.id
const storedOrder = () =>
  S()
    .projects.slice()
    .sort((a, b) => a.order - b.order)
    .map((p) => (p.group ? `${p.name}:${p.group}` : p.name))

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

// jsdom 没有 DragEvent,RTL 退回成普通 Event,init 里的 clientY 会被丢掉 —— 手动补到事件上。
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
const groupGrip = (name: string) => screen.getByRole('button', { name: `拖动调整分组 ${name} 的位置` })
const rowOf = (name: string) =>
  screen.getByRole('button', { name: `切换到剧 ${name}` }).closest('[role="listitem"]') as HTMLElement
/** 分组标题行 / 整个分组块。 */
const headerOf = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^(折叠|展开)?分组 ${name}`) }).closest('.vw-rail-ghd') as HTMLElement
const blockOf = (name: string) => headerOf(name).closest('.vw-rail-group') as HTMLElement
const listEl = () => document.querySelector('.vw-rail-list') as HTMLElement
const NAME = '.vw-rail-name > span.truncate'
/** 剧栏当前的样子:`默认项目 [G:追车戏,夜景] 第四部`;折叠着的分组只列出露出来的成员。 */
const shape = () =>
  Array.from(listEl().children)
    .filter((el) => el.matches('.vw-rail-row, .vw-rail-group'))
    .map((el) =>
      el.classList.contains('vw-rail-group')
        ? `[${el.querySelector('.vw-rail-gname')!.textContent}:${Array.from(el.querySelectorAll(`.vw-rail-kids ${NAME}`))
            .map((n) => n.textContent)
            .join(',')}]`
        : el.querySelector(NAME)!.textContent,
    )
    .join(' ')

// 行高 40(中线 20)、标题行高 30(上 1/4 < 7.5 = 放到整块前,下 1/4 > 22.5 = 之后,中间 = 放进)、分组块高 100(中线 50)
const UPPER = 10
const LOWER = 30
const HEAD_BEFORE = 3
const HEAD_INTO = 15
const HEAD_AFTER = 27
const BLOCK_UPPER = 20
const BLOCK_LOWER = 80

beforeEach(() => {
  localStorage.clear()
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(RAIL_COLLAPSED_KEY)
  useToastStore.getState().clearAll()
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const h = this.classList.contains('vw-rail-row')
      ? 40
      : this.classList.contains('vw-rail-ghd')
        ? 30
        : this.classList.contains('vw-rail-group')
          ? 100
          : 0
    return { top: 0, bottom: h, left: 0, right: 0, width: 0, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
  for (const n of ['追车戏', '夜景', '第四部']) S().addProject(n)
  S().switchProject('project-default')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 追车戏 + 夜景 进「G」。 */
const withGroup = () => {
  S().assignProjectGroup(idOf('追车戏'), 'G')
  S().assignProjectGroup(idOf('夜景'), 'G')
}

describe('结构与折叠', () => {
  it('没有分组时和以前一样:平铺的剧、没有标题、没有底部空白条;搜索框旁有「新建分组」', () => {
    render(<ProjectRail />)
    expect(shape()).toBe('默认项目 追车戏 夜景 第四部')
    expect(document.querySelector('.vw-rail-ghd')).toBeNull()
    expect(document.querySelector('.vw-rail-tail')).toBeNull()
    expect(screen.getByRole('button', { name: '新建分组' })).toBeTruthy()
  })

  it('分组出现在它第一个成员的位置:标题 + 计数 + 缩进的成员;成员行放在带名字的子列表里', () => {
    withGroup()
    render(<ProjectRail />)
    expect(shape()).toBe('默认项目 [G:追车戏,夜景] 第四部')
    expect(within(headerOf('G')).getByText('2').className).toContain('vw-rail-gcount')
    const kids = screen.getByRole('list', { name: '分组 G 里的剧' })
    expect(within(kids).getAllByRole('listitem')).toHaveLength(2)
  })

  it('分组标题上显示组内已完成成片的总时长;没有成片就不显示', () => {
    withGroup()
    render(<ProjectRail />)
    expect(headerOf('G').querySelector('.vw-rail-gagg')).toBeNull()
    act(() => {
      S().switchProject(idOf('追车戏'))
      S().addCards([{ prompt: 'a' }])
      S().switchProject(idOf('夜景'))
      S().addCards([{ prompt: 'b' }])
      useVideoWorkbenchStore.setState((s) => ({
        cards: s.cards.map((c, i) => ({ ...c, status: 'succeeded', duration: i === 0 ? 5 : 7 })),
      }))
      S().switchProject('project-default')
    })
    expect(headerOf('G').querySelector('.vw-rail-gagg')?.textContent).toBe('0:12')
  })

  it('点标题折叠 / 展开(aria-expanded 跟着变),状态存在本机、不入撤销栈;折叠后成员隐藏', () => {
    withGroup()
    render(<ProjectRail />)
    const depth = S().undoStack.length
    const toggle = () => screen.getByRole('button', { name: /分组 G$/ })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(shape()).toBe('默认项目 [G:] 第四部')
    expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY)!)).toEqual(['G'])
    expect(S().undoStack).toHaveLength(depth)
    fireEvent.click(toggle())
    expect(shape()).toBe('默认项目 [G:追车戏,夜景] 第四部')
  })

  it('折叠的分组里,正在看的那部剧仍然露出来', () => {
    withGroup()
    S().switchProject(idOf('夜景'))
    render(<ProjectRail />)
    fireEvent.click(screen.getByRole('button', { name: /折叠分组 G$/ }))
    expect(shape()).toBe('默认项目 [G:夜景] 第四部')
  })

  it('折叠前的状态在重新挂载(重进工作台)后保持', () => {
    withGroup()
    S().toggleGroupCollapsed('G')
    render(<ProjectRail />)
    expect(shape()).toBe('默认项目 [G:] 第四部')
    expect(screen.getByRole('button', { name: '展开分组 G' })).toBeTruthy()
  })

  it('搜索中、折叠到 48px 时不显示分组结构:平铺(按剧栏顺序)、没有把手', () => {
    withGroup()
    render(<ProjectRail />)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索剧' }), { target: { value: '景' } })
    expect(document.querySelector('.vw-rail-ghd')).toBeNull()
    expect(shape()).toBe('夜景')
    fireEvent.change(screen.getByRole('textbox', { name: '搜索剧' }), { target: { value: '' } })
    expect(shape()).toBe('默认项目 [G:追车戏,夜景] 第四部')
    act(() => S().setRailCollapsed(true))
    expect(document.querySelector('.vw-rail-ghd')).toBeNull()
    expect(screen.queryAllByRole('button', { name: /^拖动调整/ })).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: /切换到剧/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      '切换到剧 默认项目',
      '切换到剧 追车戏',
      '切换到剧 夜景',
      '切换到剧 第四部',
    ])
  })

  it('置顶:顶层置顶的排最前;组内置顶的排组内最前;分组本身不被带到最前', () => {
    withGroup()
    act(() => S().setProjectPinned(idOf('夜景'), true))
    render(<ProjectRail />)
    expect(shape()).toBe('默认项目 [G:夜景,追车戏] 第四部')
    act(() => S().setProjectPinned(idOf('第四部'), true))
    expect(shape()).toBe('第四部 默认项目 [G:夜景,追车戏]')
  })
})

describe('新建 / 重命名 / 解散分组', () => {
  it('⊞ 新建分组:弹小对话框,确定后出现一个空分组标题(只存本机,不入撤销栈、不写库的 group)', () => {
    render(<ProjectRail />)
    const depth = S().undoStack.length
    fireEvent.click(screen.getByRole('button', { name: '新建分组' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新名称' }), { target: { value: ' 外传 ' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(shape()).toBe('[外传:] 默认项目 追车戏 夜景 第四部')
    expect(screen.getByRole('button', { name: '分组 外传(空)' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(EMPTY_GROUPS_KEY)!)).toEqual(['外传'])
    expect(S().projects.some((p) => p.group)).toBe(false)
    expect(S().undoStack).toHaveLength(depth)
    // 空分组没有成员可挪:没有分组把手
    expect(screen.queryByRole('button', { name: '拖动调整分组 外传 的位置' })).toBeNull()
  })

  it('重名被拒:对话框保持打开,并提示原因', () => {
    withGroup()
    render(<ProjectRail />)
    fireEvent.click(screen.getByRole('button', { name: '新建分组' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新名称' }), { target: { value: 'G' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(screen.getByRole('dialog', { name: '新建分组' })).toBeTruthy()
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error' && t.message.includes('同名'))).toBe(true)
  })

  it('右键标题:重命名(所有成员一起改)/ 解散(成员回到未分组、位置不动)', () => {
    withGroup()
    render(<ProjectRail />)
    fireEvent.contextMenu(headerOf('G'))
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      expect.stringContaining('重命名'),
      expect.stringContaining('解散分组'),
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '新名称' }), { target: { value: '主线' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(shape()).toBe('默认项目 [主线:追车戏,夜景] 第四部')

    fireEvent.click(screen.getByRole('button', { name: '分组菜单 主线' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /解散分组/ }))
    expect(shape()).toBe('默认项目 追车戏 夜景 第四部')
    expect(S().projects.some((p) => p.group)).toBe(false)
  })

  it('空分组的右键菜单是「删除分组」', () => {
    S().createEmptyGroup('草稿')
    render(<ProjectRail />)
    fireEvent.contextMenu(headerOf('草稿'))
    fireEvent.click(screen.getByRole('menuitem', { name: /删除分组/ }))
    expect(document.querySelector('.vw-rail-ghd')).toBeNull()
    expect(S().emptyGroups).toEqual([])
  })
})

describe('菜单:移到分组… / 移出分组', () => {
  it('列出已有分组(含空分组),点一个就移进去;当前所在的分组标出来、不可再选', () => {
    withGroup()
    S().createEmptyGroup('空的')
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 追车戏' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /移到分组/ }))
    const dialog = screen.getByRole('dialog', { name: '把「追车戏」移到分组' })
    expect((within(dialog).getByRole('button', { name: '移到分组 G' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '移到分组 空的' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // 空分组没有位置,第一个成员放进来时原位成组(追车戏本来在 G 的第一个位置)
    expect(shape()).toBe('默认项目 [空的:追车戏] [G:夜景] 第四部')
    expect(S().emptyGroups).toEqual([])
  })

  it('键入新名字 = 新建分组并移入(原位成组)', () => {
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 夜景' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /移到分组/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '新分组名' }), { target: { value: ' 外传 ' } })
    fireEvent.click(screen.getByRole('button', { name: '新建并移入' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(shape()).toBe('默认项目 追车戏 [外传:夜景] 第四部')
  })

  it('已在组里的剧才有「移出分组」;点了留在原位、变成未分组', () => {
    withGroup()
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 第四部' }))
    expect(screen.queryByRole('menuitem', { name: /移出分组/ })).toBeNull()
    fireEvent.mouseDown(window)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 追车戏' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /移出分组/ }))
    expect(shape()).toBe('默认项目 追车戏 [G:夜景] 第四部')
  })
})

describe('拖动:剧', () => {
  it('拖到分组标题中部 = 放进该分组(标题亮虚线框),排到组内最后;放下后清掉标记', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('第四部'), { dataTransfer: dt })
    expect(dt.types).toContain(PROJECT_DRAG_MIME)
    expect(fireEvent.dragOver(headerOf('G'), { dataTransfer: dt, clientY: HEAD_INTO })).toBe(false)
    expect(dt.dropEffect).toBe('move')
    expect(headerOf('G').className).toContain('vw-rail-ghd-drop')
    fireEvent.drop(headerOf('G'), { dataTransfer: dt, clientY: HEAD_INTO })
    expect(shape()).toBe('默认项目 [G:追车戏,夜景,第四部]')
    expect(storedOrder()).toEqual(['默认项目', '追车戏:G', '夜景:G', '第四部:G'])
    expect(document.querySelector('.vw-rail-ghd-drop, .vw-rail-drop-before, .vw-rail-drop-after')).toBeNull()
  })

  it('拖到标题上 1/4 / 下 1/4 = 放到整个分组之前 / 之后(仍是未分组),画整块的上沿 / 下沿线', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('第四部'), { dataTransfer: dt })
    expect(fireEvent.dragOver(headerOf('G'), { dataTransfer: dt, clientY: HEAD_BEFORE })).toBe(false)
    expect(blockOf('G').className).toContain('vw-rail-drop-before')
    fireEvent.drop(headerOf('G'), { dataTransfer: dt, clientY: HEAD_BEFORE })
    expect(shape()).toBe('默认项目 第四部 [G:追车戏,夜景]')

    const dt2 = makeDt()
    fireEvent.dragStart(grip('默认项目'), { dataTransfer: dt2 })
    expect(fireEvent.dragOver(headerOf('G'), { dataTransfer: dt2, clientY: HEAD_AFTER })).toBe(false)
    expect(blockOf('G').className).toContain('vw-rail-drop-after')
    fireEvent.drop(headerOf('G'), { dataTransfer: dt2, clientY: HEAD_AFTER })
    expect(shape()).toBe('第四部 [G:追车戏,夜景] 默认项目')
  })

  it('拖到组内成员行上 = 进入那个分组并落在该行的前 / 后', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('第四部'), { dataTransfer: dt })
    fireEvent.dragOver(rowOf('追车戏'), { dataTransfer: dt, clientY: UPPER })
    expect(rowOf('追车戏').className).toContain('vw-rail-drop-before')
    fireEvent.drop(rowOf('追车戏'), { dataTransfer: dt, clientY: UPPER })
    expect(shape()).toBe('默认项目 [G:第四部,追车戏,夜景]')
  })

  it('把组内成员拖到顶层的行上 = 移出分组', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('追车戏'), { dataTransfer: dt })
    fireEvent.dragOver(rowOf('第四部'), { dataTransfer: dt, clientY: LOWER })
    fireEvent.drop(rowOf('第四部'), { dataTransfer: dt, clientY: LOWER })
    expect(shape()).toBe('默认项目 [G:夜景] 第四部 追车戏')
    expect('group' in S().projects.find((p) => p.name === '追车戏')!).toBe(false)
  })

  it('拖到空分组标题上 = 它的第一个成员;空分组的整个标题都是「放进」', () => {
    S().createEmptyGroup('新篇')
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('夜景'), { dataTransfer: dt })
    expect(fireEvent.dragOver(headerOf('新篇'), { dataTransfer: dt, clientY: HEAD_BEFORE })).toBe(false)
    expect(headerOf('新篇').className).toContain('vw-rail-ghd-drop')
    fireEvent.drop(headerOf('新篇'), { dataTransfer: dt, clientY: HEAD_BEFORE })
    expect(shape()).toBe('默认项目 追车戏 [新篇:夜景] 第四部')
    expect(S().emptyGroups).toEqual([])
  })

  it('放进一个折叠着的分组:顺手展开,剧不会「消失」在里面', () => {
    withGroup()
    S().toggleGroupCollapsed('G')
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('第四部'), { dataTransfer: dt })
    fireEvent.drop(headerOf('G'), { dataTransfer: dt, clientY: HEAD_INTO })
    expect(shape()).toBe('默认项目 [G:追车戏,夜景,第四部]')
  })

  it('不能放的地方不画线、光标禁止:自己所在分组只有它一个时的 before / after、跨置顶', () => {
    S().assignProjectGroup(idOf('夜景'), '独苗')
    act(() => S().setProjectPinned(idOf('追车戏'), true))
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('夜景'), { dataTransfer: dt })
    expect(fireEvent.dragOver(headerOf('独苗'), { dataTransfer: dt, clientY: HEAD_BEFORE })).toBe(true)
    expect(dt.dropEffect).toBe('none')
    // 追车戏是置顶的、夜景不是:不能互换
    expect(fireEvent.dragOver(rowOf('追车戏'), { dataTransfer: dt, clientY: LOWER })).toBe(true)
    expect(document.querySelector('.vw-rail-ghd-drop, .vw-rail-drop-before, .vw-rail-drop-after')).toBeNull()
    const revision = S().revision
    fireEvent.drop(rowOf('追车戏'), { dataTransfer: dt, clientY: LOWER })
    expect(S().revision).toBe(revision)
  })

  it('列表底部的空白条:拖到那里 = 移出分组并排到最后(只在有分组时才有这条)', () => {
    withGroup()
    render(<ProjectRail />)
    const tail = document.querySelector('.vw-rail-tail') as HTMLElement
    expect(tail).toBeTruthy()
    const dt = makeDt()
    fireEvent.dragStart(grip('追车戏'), { dataTransfer: dt })
    expect(fireEvent.dragOver(tail, { dataTransfer: dt })).toBe(false)
    expect(tail.className).toContain('vw-rail-tail-on')
    fireEvent.drop(tail, { dataTransfer: dt })
    expect(shape()).toBe('默认项目 [G:夜景] 第四部 追车戏')
    expect(document.querySelector('.vw-rail-tail-on')).toBeNull()
  })

  it('列表自己(不是某一行)上空的空白区也算「底部空白」', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(grip('追车戏'), { dataTransfer: dt })
    expect(fireEvent.dragOver(listEl(), { dataTransfer: dt })).toBe(false)
    expect(document.querySelector('.vw-rail-tail-on')).not.toBeNull()
    fireEvent.drop(listEl(), { dataTransfer: dt })
    expect(shape()).toBe('默认项目 [G:夜景] 第四部 追车戏')
  })

  it('一步撤销:拖进分组后 Ctrl+Z(undo)回到拖之前的剧栏', async () => {
    withGroup()
    render(<ProjectRail />)
    const before = shape()
    const dt = makeDt()
    fireEvent.dragStart(grip('第四部'), { dataTransfer: dt })
    fireEvent.drop(headerOf('G'), { dataTransfer: dt, clientY: HEAD_INTO })
    expect(shape()).not.toBe(before)
    await act(async () => {
      await S().undo()
    })
    expect(shape()).toBe(before)
  })
})

describe('拖动:整个分组', () => {
  it('分组标题上有把手(拖影是整个分组块,不是把手);拖到一个未分组的行的上 / 下半 = 整块排到它前 / 后', async () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(groupGrip('G'), { dataTransfer: dt })
    expect(dt.types).toContain(GROUP_DRAG_MIME)
    expect(dt.getData(GROUP_DRAG_MIME)).toBe('G')
    expect((dt.setDragImage.mock.calls[0] as unknown[])[0]).toBe(blockOf('G'))
    await waitFor(() => expect(blockOf('G').className).toContain('vw-rail-group-dragging'))

    expect(fireEvent.dragOver(rowOf('第四部'), { dataTransfer: dt, clientY: LOWER })).toBe(false)
    expect(rowOf('第四部').className).toContain('vw-rail-drop-after')
    fireEvent.drop(rowOf('第四部'), { dataTransfer: dt, clientY: LOWER })
    expect(shape()).toBe('默认项目 第四部 [G:追车戏,夜景]')
    expect(storedOrder()).toEqual(['默认项目', '第四部', '追车戏:G', '夜景:G'])
  })

  it('经过自己的成员行 / 自己的标题:禁止;经过另一个分组:按整块上 / 下半放到它前 / 后', () => {
    S().assignProjectGroup(idOf('追车戏'), 'X')
    S().assignProjectGroup(idOf('夜景'), 'Y')
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(groupGrip('X'), { dataTransfer: dt })
    expect(fireEvent.dragOver(rowOf('追车戏'), { dataTransfer: dt, clientY: UPPER })).toBe(true)
    expect(fireEvent.dragOver(headerOf('X'), { dataTransfer: dt, clientY: HEAD_AFTER })).toBe(true)
    expect(dt.dropEffect).toBe('none')
    expect(document.querySelector('.vw-rail-drop-before, .vw-rail-drop-after')).toBeNull()

    // 经过 Y 的标题(冒泡到 Y 的分组块;块高 100 的 mock 里,clientY 27 在上半 = 「放到 Y 之前」)。
    // X 本来就在 Y 之前 → 布局不变 → 不能放(没有线、光标禁止)
    expect(fireEvent.dragOver(headerOf('Y'), { dataTransfer: dt, clientY: HEAD_AFTER })).toBe(true)
    expect(dt.dropEffect).toBe('none')
    expect(document.querySelector('.vw-rail-drop-before, .vw-rail-drop-after')).toBeNull()
    // 下半 = 放到 Y 之后 → 真的有变化
    expect(fireEvent.dragOver(blockOf('Y'), { dataTransfer: dt, clientY: BLOCK_LOWER })).toBe(false)
    expect(blockOf('Y').className).toContain('vw-rail-drop-after')
    fireEvent.drop(blockOf('Y'), { dataTransfer: dt, clientY: BLOCK_LOWER })
    expect(shape()).toBe('默认项目 [Y:夜景] [X:追车戏] 第四部')
  })

  it('拖整个分组到列表底部空白 = 排到最后', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(groupGrip('G'), { dataTransfer: dt })
    const tail = document.querySelector('.vw-rail-tail') as HTMLElement
    expect(fireEvent.dragOver(tail, { dataTransfer: dt })).toBe(false)
    fireEvent.drop(tail, { dataTransfer: dt })
    expect(shape()).toBe('默认项目 第四部 [G:追车戏,夜景]')
  })

  it('拖动的数据里没有对应的类型(别处来的拖动 / 残留的状态)→ 不接收、不画线、不落地', () => {
    withGroup()
    render(<ProjectRail />)
    const foreign = makeDt() // 没有任何自定义类型
    // 分组拖动开始后,经过的却是别的来源的拖动
    fireEvent.dragStart(groupGrip('G'), { dataTransfer: makeDt() })
    expect(fireEvent.dragOver(rowOf('第四部'), { dataTransfer: foreign, clientY: LOWER })).toBe(true)
    expect(document.querySelector('.vw-rail-drop-before, .vw-rail-drop-after')).toBeNull()
    fireEvent.drop(rowOf('第四部'), { dataTransfer: foreign, clientY: LOWER })
    expect(shape()).toBe('默认项目 [G:追车戏,夜景] 第四部')
    // 剧的拖动同理
    fireEvent.dragEnd(groupGrip('G'), { dataTransfer: makeDt() })
    fireEvent.dragStart(grip('第四部'), { dataTransfer: makeDt() })
    expect(fireEvent.dragOver(rowOf('默认项目'), { dataTransfer: foreign, clientY: UPPER })).toBe(true)
    fireEvent.drop(rowOf('默认项目'), { dataTransfer: foreign, clientY: UPPER })
    expect(shape()).toBe('默认项目 [G:追车戏,夜景] 第四部')
  })

  it('剧不能被当成分组拖放(两种拖动互不串)', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(groupGrip('G'), { dataTransfer: dt })
    fireEvent.dragEnd(groupGrip('G'), { dataTransfer: dt })
    // dragend 之后残留的 drop 被忽略
    fireEvent.drop(rowOf('第四部'), { dataTransfer: dt, clientY: LOWER })
    expect(shape()).toBe('默认项目 [G:追车戏,夜景] 第四部')
  })
})

describe('拖动:分段卡', () => {
  it('分段卡不能放在分组标题上(它要放进某一部剧):光标禁止、不接收', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    dt.setData(SEGMENT_DRAG_MIME, 'some-board')
    expect(fireEvent.dragOver(headerOf('G'), { dataTransfer: dt, clientY: HEAD_INTO })).toBe(true)
    expect(dt.dropEffect).toBe('none')
  })

  it('仍然可以放在组内某部剧的行上 = 移到那部剧(沿用原有拖法)', () => {
    withGroup()
    // 默认项目有两个分段,才允许搬走一个
    S().addBoard('第二段')
    const board = S().boards.find((b) => b.projectId === 'project-default' && b.name === '第二段')!
    render(<ProjectRail />)
    const dt = makeDt()
    dt.setData(SEGMENT_DRAG_MIME, board.id)
    const btn = screen.getByRole('button', { name: '切换到剧 追车戏' })
    expect(fireEvent.dragOver(btn, { dataTransfer: dt })).toBe(false)
    fireEvent.drop(btn, { dataTransfer: dt })
    expect(S().boards.find((b) => b.id === board.id)!.projectId).toBe(idOf('追车戏'))
  })
})

describe('键盘排序', () => {
  it('组内成员 ↓ ↑ 在组内换位,到头不出组;焦点留在把手上', () => {
    withGroup()
    render(<ProjectRail />)
    grip('追车戏').focus()
    fireEvent.keyDown(grip('追车戏'), { key: 'ArrowDown' })
    expect(shape()).toBe('默认项目 [G:夜景,追车戏] 第四部')
    expect(document.activeElement).toBe(grip('追车戏'))
    const revision = S().revision
    fireEvent.keyDown(grip('追车戏'), { key: 'ArrowDown' })
    expect(S().revision).toBe(revision)
    expect(shape()).toBe('默认项目 [G:夜景,追车戏] 第四部')
  })

  it('顶层的剧遇到分组整块跳过去,自己仍是未分组', () => {
    withGroup()
    render(<ProjectRail />)
    fireEvent.keyDown(grip('第四部'), { key: 'ArrowUp' })
    expect(shape()).toBe('默认项目 第四部 [G:追车戏,夜景]')
    fireEvent.keyDown(grip('默认项目'), { key: 'ArrowDown' })
    expect(shape()).toBe('第四部 默认项目 [G:追车戏,夜景]')
  })

  it('分组把手 ↓ ↑ 把整个分组和相邻的一项换位', () => {
    withGroup()
    render(<ProjectRail />)
    groupGrip('G').focus()
    fireEvent.keyDown(groupGrip('G'), { key: 'ArrowDown' })
    expect(shape()).toBe('默认项目 第四部 [G:追车戏,夜景]')
    expect(document.activeElement).toBe(groupGrip('G'))
    fireEvent.keyDown(groupGrip('G'), { key: 'ArrowUp' })
    fireEvent.keyDown(groupGrip('G'), { key: 'ArrowUp' })
    expect(shape()).toBe('[G:追车戏,夜景] 默认项目 第四部')
  })
})

// 直接拖:不必找左边的点阵 —— 抓分组标题的任何地方(折叠箭头、名字、计数)就能拖整个分组;
// 组内成员行和未分组的行一样整行可拖。
describe('直接拖:分组标题与组内成员', () => {
  it('非空分组的标题 draggable;搜索中 / 折叠到 48px 时没有标题、行也不可拖', () => {
    withGroup()
    render(<ProjectRail />)
    expect(headerOf('G').getAttribute('draggable')).toBe('true')
    expect(rowOf('追车戏').getAttribute('draggable')).toBe('true')
    // 搜索 → 平铺、没有标题,行也不可拖
    fireEvent.change(screen.getByRole('textbox', { name: '搜索剧' }), { target: { value: '景' } })
    expect(document.querySelector('.vw-rail-ghd')).toBeNull()
    expect(rowOf('夜景').getAttribute('draggable')).toBe('false')
    fireEvent.change(screen.getByRole('textbox', { name: '搜索剧' }), { target: { value: '' } })
    act(() => S().setRailCollapsed(true))
    expect(document.querySelector('.vw-rail-ghd')).toBeNull()
    expect(rowOf('夜景').getAttribute('draggable')).toBe('false')
  })

  it('空分组的标题不可拖(没有成员可挪)', () => {
    act(() => void S().createEmptyGroup('外传'))
    render(<ProjectRail />)
    expect(headerOf('外传').getAttribute('draggable')).toBe('false')
  })

  it('抓标题上的名字按钮拖:起拖的是整个分组,拖影是整个分组块,放下后整块挪位', async () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(screen.getByRole('button', { name: /^(折叠|展开)分组 G/ }), { dataTransfer: dt })
    expect(dt.getData(GROUP_DRAG_MIME)).toBe('G')
    expect(dt.types).not.toContain(PROJECT_DRAG_MIME)
    expect((dt.setDragImage.mock.calls[0] as unknown[])[0]).toBe(blockOf('G'))
    await waitFor(() => expect(blockOf('G').className).toContain('vw-rail-group-dragging'))
    fireEvent.drop(rowOf('第四部'), { dataTransfer: dt, clientY: LOWER })
    expect(shape()).toBe('默认项目 第四部 [G:追车戏,夜景]')
  })

  it('抓左边的点阵拖分组:只起一次拖(冒泡到标题,不会认领两遍)', () => {
    withGroup()
    render(<ProjectRail />)
    const dt = makeDt()
    fireEvent.dragStart(groupGrip('G'), { dataTransfer: dt })
    expect(dt.setDragImage).toHaveBeenCalledTimes(1)
    expect(dt.getData(GROUP_DRAG_MIME)).toBe('G')
  })

  it('组内成员行整行可拖:抓名字起拖的是这部剧(不是整个分组),可以拖出分组', () => {
    withGroup()
    render(<ProjectRail />)
    expect(rowOf('追车戏').getAttribute('draggable')).toBe('true')
    const dt = makeDt()
    fireEvent.dragStart(screen.getByRole('button', { name: '切换到剧 追车戏' }), { dataTransfer: dt })
    expect(dt.getData(PROJECT_DRAG_MIME)).toBe(idOf('追车戏'))
    expect(dt.types).not.toContain(GROUP_DRAG_MIME)
    // 放到未分组的「第四部」下半 = 移出分组、排到它后面
    fireEvent.dragOver(rowOf('第四部'), { dataTransfer: dt, clientY: LOWER })
    fireEvent.drop(rowOf('第四部'), { dataTransfer: dt, clientY: LOWER })
    expect(storedOrder()).not.toContain('追车戏:G')
    expect(S().projects.find((p) => p.name === '追车戏')!.group).toBeUndefined()
  })

  it('点标题仍是折叠 / 展开:标题可拖不抢这个手势', () => {
    withGroup()
    render(<ProjectRail />)
    fireEvent.click(screen.getByRole('button', { name: '折叠分组 G' }))
    expect(screen.getByRole('button', { name: '展开分组 G' })).toBeTruthy()
  })
})
