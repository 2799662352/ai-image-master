// 用户报的两条拖拽故障 + 我自己查出来的第三条(静默数据丢失)。
//
// 1. 按住卡片往聊天栏拖 → 拖不动,变成选中文字。
//    原因:只有那个 ⣿ 小手柄 draggable,而且头部行没有 select-none。
// 2. 文件栏里的图片拖进工作台 → 没反应。
//    原因:handleDragOver 只认 Files / 卡片 MIME;文件栏内部拖拽带的是
//    application/x-catimation-file-paths 且没有 dataTransfer.files,
//    没 preventDefault 就压根不会派发 drop。
// 3. (未被报告)卡片拖过文件树 → mp4 被 fs.move 移走。
//    原因:卡片当时复用了文件路径 MIME,而那个 MIME 在文件树里的含义是「可移动的
//    工作区文件」。文件栏挂在 AgentChatPanel 上,与工作台同屏,所以这是日常动作。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

const FILE_PATHS_MIME = 'application/x-catimation-file-paths'
const WORKBENCH_CARD_MIME = 'application/x-catimation-workbench-cards'
const CARD_DRAG_MIME = 'application/x-vw-card'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

/** jsdom 没有 DataTransfer;同目录 MaterialStack.test.tsx 是同款替身。 */
function fakeDataTransfer(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed }
  return {
    get types() {
      return Object.keys(data)
    },
    effectAllowed: '',
    dropEffect: '',
    files: [] as unknown as FileList,
    setData(t: string, v: string) {
      data[t] = v
    },
    getData(t: string) {
      return data[t] ?? ''
    },
  } as unknown as DataTransfer
}

function seedAndRender(n: number): string[] {
  const ids = useVideoWorkbenchStore.getState().addCards(
    Array.from({ length: n }, (_, i) => ({ prompt: `p${i}` })),
  )
  useVideoWorkbenchStore.setState({ hydrated: true })
  render(<VideoWorkbenchPage />)
  return ids
}

function giveLocalPath(id: string, localPath: string): void {
  useVideoWorkbenchStore.setState((s) => ({
    cards: s.cards.map((c) =>
      c.id === id ? { ...c, status: 'succeeded' as const, localPath } : c,
    ),
  }))
}

function header(i = 0): HTMLElement {
  return screen.getAllByTestId('vw-card-header')[i]
}

describe('拖不动:整条头部行必须可拖,且不能被文字选中抢走', () => {
  it('头部行自身 draggable —— 不再只有那个 ⣿ 小手柄', () => {
    seedAndRender(1)
    expect(header().draggable).toBe(true)
  })

  it('头部行带 select-none —— 否则按住往外拖会变成选中「#02」这几个字', () => {
    seedAndRender(1)
    expect(header().className).toContain('select-none')
  })

  it('从头部行起手就能拿到载荷(不必精确命中手柄)', () => {
    const ids = seedAndRender(1)
    giveLocalPath(ids[0], 'C:/u/agent/uploads/a.mp4')
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(header(), { dataTransfer })

    expect(dataTransfer.getData(CARD_DRAG_MIME)).toBe(ids[0])
    const payload = JSON.parse(dataTransfer.getData(WORKBENCH_CARD_MIME))
    expect(payload).toHaveLength(1)
    expect(payload[0]).toMatchObject({ cardId: ids[0], localPath: 'C:/u/agent/uploads/a.mp4' })
    expect(dataTransfer.effectAllowed).toBe('copyMove')
  })

  it('从头部行里的按钮起手不启动拖拽 —— 删除键还是删除键', () => {
    seedAndRender(1)
    const button = header().querySelector('button')
    expect(button).toBeTruthy()
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(button!, { dataTransfer })
    expect(dataTransfer.types).toEqual([])
  })
})

describe('数据丢失守卫:卡片载荷绝不能伪装成「可移动的工作区文件」', () => {
  it('不写 x-catimation-file-paths —— 文件树见到它会 fs.move 掉 mp4', () => {
    const ids = seedAndRender(1)
    giveLocalPath(ids[0], 'C:/u/agent/uploads/a.mp4')
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(header(), { dataTransfer })

    // 这一条是整个修复的核心。放松它等于把 mp4 重新暴露给 moveByDnd。
    expect(dataTransfer.types).not.toContain(FILE_PATHS_MIME)
  })

  it('还没出片的卡带上 cardId + 规格摘要,但不带路径 —— 聊天栏据此合成一份说明递给模型', () => {
    // 刻意不选择「什么都不写」:那样拖过去毫无反应,用户分不清是没做好还是拖失败了。
    // 断言从整体相等放松成逐字段,是因为载荷现在还要带状态与规格摘要(未出片时聊天栏
    // 靠它合成说明);唯一不能松的是「不带路径」和下面那条 FILE_PATHS_MIME 守卫。
    const ids = seedAndRender(1)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(header(), { dataTransfer })

    const payload = JSON.parse(dataTransfer.getData(WORKBENCH_CARD_MIME))
    expect(payload).toHaveLength(1)
    expect(payload[0]).toMatchObject({ cardId: ids[0], status: 'draft' })
    expect(payload[0].localPath).toBeUndefined()
    expect(payload[0].remoteUrl).toBeUndefined()
    expect(payload[0].spec.prompt).toBe('p0')
    expect(dataTransfer.types).not.toContain(FILE_PATHS_MIME)
    expect(dataTransfer.getData(CARD_DRAG_MIME)).toBe(ids[0])
  })

  it('素材只带名字,不把 data: URL 拖进载荷 —— 否则一次拖拽拖着几十 MB base64 走', () => {
    const ids = seedAndRender(1)
    const dataURL = `data:image/png;base64,${'A'.repeat(2048)}`
    // 直接写 store 而不走 addMaterials:后者会顺带发起素材转存(要 electronAPI),
    // 这条测试只关心载荷里装了什么。
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) =>
        c.id === ids[0] ? { ...c, referenceImages: [{ name: '猫.png', src: dataURL }] } : c,
      ),
    }))
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(header(), { dataTransfer })

    const raw = dataTransfer.getData(WORKBENCH_CARD_MIME)
    expect(raw).not.toContain('base64')
    expect(JSON.parse(raw)[0].spec.referenceBrief.images).toEqual(['猫.png'])
  })
})

describe('文件栏拖进工作台:只有路径、没有 File 的那一类', () => {
  it('dragOver 必须 preventDefault,否则浏览器压根不派发 drop', () => {
    seedAndRender(1)
    const card = screen.getByTestId(`vw-card-${useVideoWorkbenchStore.getState().cards[0].id}`)
    const dataTransfer = fakeDataTransfer({ [FILE_PATHS_MIME]: JSON.stringify(['D:/ws/a.png']) })
    // fireEvent 返回 false 表示被 preventDefault 了 = 这里可以放
    const accepted = !fireEvent.dragOver(card, { dataTransfer })
    expect(accepted).toBe(true)
  })

  it('图片按扩展名归入参考图', () => {
    const ids = seedAndRender(1)
    const card = screen.getByTestId(`vw-card-${ids[0]}`)
    const dataTransfer = fakeDataTransfer({
      [FILE_PATHS_MIME]: JSON.stringify(['D:/ws/生成图.png']),
    })
    fireEvent.drop(card, { dataTransfer })

    const updated = useVideoWorkbenchStore.getState().cards[0]
    expect(updated.referenceImages.map((m) => m.name)).toEqual(['生成图.png'])
  })

  it('视频与音频各归其位,认不出类型的整条丢弃', () => {
    const ids = seedAndRender(1)
    const card = screen.getByTestId(`vw-card-${ids[0]}`)
    fireEvent.drop(card, {
      dataTransfer: fakeDataTransfer({
        [FILE_PATHS_MIME]: JSON.stringify(['D:/ws/a.mp4', 'D:/ws/b.mp3', 'D:/ws/说明.txt']),
      }),
    })

    const updated = useVideoWorkbenchStore.getState().cards[0]
    expect(updated.referenceVideos.map((m) => m.name)).toEqual(['a.mp4'])
    expect(updated.referenceAudios.map((m) => m.name)).toEqual(['b.mp3'])
    // .txt 不该被猜成图片:错误会推迟到提交时才由上游报出来
    expect(updated.referenceImages).toEqual([])
  })

  it('渲染中的卡不吃新素材', () => {
    const ids = seedAndRender(1)
    // 必须走 act:否则 React 还没把新的 busy 提交到 DOM 上那个 drop 处理器,
    // 测的就成了改状态之前的旧闭包。
    act(() => {
      useVideoWorkbenchStore.setState((s) => ({
        cards: s.cards.map((c) => (c.id === ids[0] ? { ...c, status: 'running' as const } : c)),
      }))
    })
    const card = screen.getByTestId(`vw-card-${ids[0]}`)
    fireEvent.drop(card, {
      dataTransfer: fakeDataTransfer({ [FILE_PATHS_MIME]: JSON.stringify(['D:/ws/a.png']) }),
    })
    expect(useVideoWorkbenchStore.getState().cards[0].referenceImages).toEqual([])
  })
})
