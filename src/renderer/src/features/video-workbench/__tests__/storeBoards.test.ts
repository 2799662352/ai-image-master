// 工作台多「页」(board)管理单测:建/切/重命名/删/旧数据迁移/跨页任务回流/持久化。
// IndexedDB 在 jsdom 缺失 → WorkbenchDb 自动内存降级,重载语义 = 只 reset store 不 reset db。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../types/seedance'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import {
  ACTIVE_BOARD_KEY,
  buildCard,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

function boardCards(boardId: string): VideoWorkbenchCard[] {
  return useVideoWorkbenchStore.getState().cards.filter((c) => c.boardId === boardId)
}

function makeUpdate(patch: Partial<SeedanceTaskUpdate>): SeedanceTaskUpdate {
  return {
    taskId: 'task-1',
    prompt: 'p',
    model: '2.0',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    persistence: 'idle',
    source: 'workbench',
    ...patch,
  }
}

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
})

describe('默认页与新建页', () => {
  it('初始即有一个默认页「页面 1」,addCards 卡片归属当前页', () => {
    const state = useVideoWorkbenchStore.getState()
    expect(state.boards).toHaveLength(1)
    expect(state.boards[0].name).toBe('页面 1')
    expect(state.activeBoardId).toBe(state.boards[0].id)

    state.addCards([{ prompt: '猫' }])
    expect(boardCards(state.activeBoardId)).toHaveLength(1)
  })

  it('addBoard 自动命名「分段 2」并切换过去;两段卡片互相隔离', () => {
    const store = useVideoWorkbenchStore.getState()
    const firstId = store.activeBoardId
    store.addCards([{ prompt: 'A1' }])

    const secondId = store.addBoard()
    const state = useVideoWorkbenchStore.getState()
    expect(state.boards).toHaveLength(2)
    // 新建的段叫「分段 N」(剧/分段两层后的新文案);老数据的「页面 N」名字不动
    expect(state.boards[1].name).toBe('分段 2')
    expect(state.activeBoardId).toBe(secondId)

    useVideoWorkbenchStore.getState().addCards([{ prompt: 'B1' }, { prompt: 'B2' }])
    expect(boardCards(firstId).map((c) => c.prompt)).toEqual(['A1'])
    expect(boardCards(secondId).map((c) => c.prompt)).toEqual(['B1', 'B2'])
    // 每页 order 独立从 0 计
    expect(boardCards(secondId).map((c) => c.order)).toEqual([0, 1])
  })

  it('addBoard 指定名称;自动命名跳过已占用的「分段 N」', () => {
    const store = useVideoWorkbenchStore.getState()
    store.addBoard('分段 2')
    const id3 = useVideoWorkbenchStore.getState().addBoard()
    const boards = useVideoWorkbenchStore.getState().boards
    expect(boards.find((b) => b.id === id3)!.name).toBe('分段 3')
  })
})

describe('switchBoard / renameBoard / removeBoard', () => {
  it('switchBoard 切换 activeBoardId 并写 localStorage', () => {
    const store = useVideoWorkbenchStore.getState()
    const firstId = store.activeBoardId
    const secondId = store.addBoard()
    useVideoWorkbenchStore.getState().switchBoard(firstId)
    expect(useVideoWorkbenchStore.getState().activeBoardId).toBe(firstId)
    expect(localStorage.getItem(ACTIVE_BOARD_KEY)).toBe(firstId)
    // 切不存在的页 → 不动
    useVideoWorkbenchStore.getState().switchBoard('ghost')
    expect(useVideoWorkbenchStore.getState().activeBoardId).toBe(firstId)
    void secondId
  })

  it('renameBoard 生效;空白名拒绝', () => {
    const store = useVideoWorkbenchStore.getState()
    const id = store.activeBoardId
    expect(store.renameBoard(id, ' 我的分镜 ')).toBe(true)
    expect(useVideoWorkbenchStore.getState().boards[0].name).toBe('我的分镜')
    expect(useVideoWorkbenchStore.getState().renameBoard(id, '   ')).toBe(false)
    expect(useVideoWorkbenchStore.getState().boards[0].name).toBe('我的分镜')
  })

  it('removeBoard 连带删卡;激活页被删则切到剩余页;仅剩一页拒绝删除', () => {
    const store = useVideoWorkbenchStore.getState()
    const firstId = store.activeBoardId
    // 仅剩一页不可删
    expect(store.removeBoard(firstId)).toBe(false)

    const secondId = store.addBoard()
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'B1' }])
    expect(useVideoWorkbenchStore.getState().removeBoard(secondId)).toBe(true)

    const state = useVideoWorkbenchStore.getState()
    expect(state.boards).toHaveLength(1)
    expect(state.activeBoardId).toBe(firstId)
    // 第二页卡片被清掉
    expect(state.cards).toHaveLength(0)
  })
})

describe('旧数据迁移 + 持久化恢复', () => {
  it('老单页草稿(卡片无 boardId、无 boards)迁入第一页,不丢卡', async () => {
    const db = getWorkbenchDb()
    const legacy = buildCard({ prompt: '旧卡片' }, 0) as VideoWorkbenchCard
    delete (legacy as Partial<VideoWorkbenchCard>).boardId
    await db.put(legacy)

    await useVideoWorkbenchStore.getState().ensureHydrated()
    const state = useVideoWorkbenchStore.getState()
    expect(state.boards).toHaveLength(1)
    expect(state.boards[0].name).toBe('页面 1')
    const migrated = state.cards.find((c) => c.prompt === '旧卡片')
    expect(migrated).toBeTruthy()
    expect(migrated!.boardId).toBe(state.boards[0].id)
  })

  it('页列表/名称/当前页跨「重载」恢复(reset store 不 reset db)', async () => {
    const store = useVideoWorkbenchStore.getState()
    await store.ensureHydrated()
    const secondId = useVideoWorkbenchStore.getState().addBoard('分镜页')
    useVideoWorkbenchStore.getState().addCards([{ prompt: '在分镜页' }])

    // 模拟重载:只重置 store,内存 db 与 localStorage 保留
    resetWorkbenchStoreForTest()
    await useVideoWorkbenchStore.getState().ensureHydrated()

    const state = useVideoWorkbenchStore.getState()
    expect(state.boards.map((b) => b.name)).toEqual(['页面 1', '分镜页'])
    expect(state.activeBoardId).toBe(secondId)
    expect(boardCards(secondId).map((c) => c.prompt)).toEqual(['在分镜页'])
  })
})

describe('跨页任务回流与排序隔离', () => {
  it('切到别的页后,applyTaskUpdate 仍按 clientId 找到原页卡片推进状态', async () => {
    const submit = vi.fn(async () => ({ success: true, taskId: 'task-1' }))
    ;(window as any).electronAPI = { videoWorkbench: { submit } }

    const store = useVideoWorkbenchStore.getState()
    const firstId = store.activeBoardId
    store.addCards([{ prompt: '猫' }])
    await useVideoWorkbenchStore.getState().startCards()
    const clientId = boardCards(firstId)[0].clientId!

    useVideoWorkbenchStore.getState().addBoard() // 切到页 2
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running' }))
    expect(boardCards(firstId)[0].status).toBe('running')
  })

  it('moveCard 只在卡片所属页内重排,不影响其他页 order', () => {
    const store = useVideoWorkbenchStore.getState()
    const firstId = store.activeBoardId
    const [a, b] = store.addCards([{ prompt: 'A' }, { prompt: 'B' }])
    const secondId = useVideoWorkbenchStore.getState().addBoard()
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'C' }])

    useVideoWorkbenchStore.getState().moveCard(b, 0)
    expect(boardCards(firstId).sort((x, y) => x.order - y.order).map((c) => c.id)).toEqual([b, a])
    expect(boardCards(secondId).map((c) => c.order)).toEqual([0])
  })
})
