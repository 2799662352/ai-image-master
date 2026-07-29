// 不阻塞 + 批次完成推送。这两件事是一个功能的两半:
//   ① startCards 立刻返回(不等 submit 的重活)—— 否则 agent 的 turn 被工具调用
//      占死,用户插不进话(video_workbench_start 卡住的根因);
//   ② 批次跑完主动推一条摘要 —— 取代让模型轮询 video_workbench_status。
//
// 第一条的红/绿很关键:回到 `await Promise.all(submissions)` 的写法时,下面那条
// 「submit 挂着也要返回」的用例会直接超时。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../types/seedance'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import {
  AGENT_BATCH_STORAGE_KEY,
  __resetWorkbenchBatches,
  mountWorkbenchBatchWatcher,
  registerAgentBatch,
  type WorkbenchBatchNotice,
} from '../batchCompletion'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'

function mockSubmit(impl?: (payload: Record<string, unknown>) => Promise<unknown>) {
  const submit = vi.fn(impl ?? (async () => ({ success: true, taskId: 'task-1' })))
  ;(window as any).electronAPI = { videoWorkbench: { submit } }
  return submit
}

function setCard(cardId: string, patch: Partial<VideoWorkbenchCard>): void {
  useVideoWorkbenchStore.setState((state) => ({
    cards: state.cards.map((c) => (c.id === cardId ? { ...c, ...patch } : c)),
  }))
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

let delivered: WorkbenchBatchNotice[]
let unmount: () => void

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  __resetWorkbenchBatches()
  delete (window as any).electronAPI
  delivered = []
  unmount?.()
  // 结算要求卡片已经读回来(见 settle 的水合闸)。这几个用例都是「应用已经跑起来」
  // 的场景,直接标记水合完成;专门测水合闸的那条用例自己把它扳回 false。
  useVideoWorkbenchStore.setState({ hydrated: true })
  unmount = mountWorkbenchBatchWatcher((notice) => delivered.push(notice))
})

describe('startCards 不阻塞', () => {
  it('submit 还挂着就已经返回 —— turn 不被前置重活(素材上送/createTask)拖住', async () => {
    let release: ((value: unknown) => void) | undefined
    mockSubmit(() => new Promise((r) => { release = r }))
    useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])

    // 回到 await Promise.all(submissions) 的写法时,这一行永远不返回。
    const result = await useVideoWorkbenchStore.getState().startCards()

    expect(result.started).toHaveLength(1)
    // 卡片在提交前就已同步落 preparing —— 用户看得到进度,这才是交付通道。
    expect(useVideoWorkbenchStore.getState().cards[0].status).toBe('preparing')
    release?.({ success: true, taskId: 'task-1' })
  })
})

describe('批次完成推送', () => {
  it('还有卡在飞时不推;全部落终态才推一次,带计数/错误/落盘位置', async () => {
    mockSubmit()
    const store = useVideoWorkbenchStore.getState()
    const ids = store.addCards([{ prompt: '猫' }, { prompt: '狗' }])
    await useVideoWorkbenchStore.getState().startCards(ids)
    registerAgentBatch(ids, 'th-1')

    setCard(ids[0], { status: 'succeeded', remoteUrl: 'https://cos/cat.mp4' })
    expect(delivered).toHaveLength(0) // 第二张还在飞

    setCard(ids[1], { status: 'failed', error: 'SEEDANCE_KEY_MISSING' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      threadId: 'th-1',
      total: 2,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
    })
    expect(delivered[0].text).toContain('1 张成功')
    expect(delivered[0].text).toContain('SEEDANCE_KEY_MISSING')
    expect(delivered[0].text).toContain('https://cos/cat.mp4')

    // 批次已注销:后续任何变更都不再重复推送(否则每条广播都要惊动模型一次)。
    setCard(ids[0], { status: 'succeeded', localPath: 'D:\\out\\cat.mp4' })
    expect(delivered).toHaveLength(1)
  })

  it('走真实广播路径(applyTaskUpdate)同样能感知终态', async () => {
    mockSubmit()
    const store = useVideoWorkbenchStore.getState()
    const ids = store.addCards([{ prompt: '猫' }])
    await useVideoWorkbenchStore.getState().startCards(ids)
    registerAgentBatch(ids, 'th-1')
    const clientId = useVideoWorkbenchStore.getState().cards[0].clientId!

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running' }))
    expect(delivered).toHaveLength(0)

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, status: 'succeeded', videoUrl: 'https://ark/cat.mp4', persistence: 'done' }),
    )
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]).toMatchObject({ total: 1, succeeded: 1 })
  })

  it('登记时就已经全部落终态(提交同步失败)也会推 —— 不能等一个不会来的变更', async () => {
    // preload 桥缺失:startCards 全部 skip,一张也没起来。
    const store = useVideoWorkbenchStore.getState()
    const ids = store.addCards([{ prompt: '猫' }])
    setCard(ids[0], { status: 'failed', error: 'boom' })

    registerAgentBatch(ids, 'th-1')

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ total: 1, failed: 1 })
  })

  it('空批次不登记;整批被删则静默丢弃(没有可汇报的内容)', () => {
    registerAgentBatch([], 'th-1')
    expect(delivered).toHaveLength(0)

    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    setCard(ids[0], { status: 'succeeded' })
    useVideoWorkbenchStore.getState().removeCard(ids[0])
    registerAgentBatch(ids, 'th-1')
    expect(delivered).toHaveLength(0)
  })

  it('用户在页面上手点启动的卡片不登记 —— 他自己看得见,不必打扰模型', async () => {
    mockSubmit()
    const store = useVideoWorkbenchStore.getState()
    const ids = store.addCards([{ prompt: '猫' }])
    // 没有 registerAgentBatch:这条路径就是 UI 按钮。
    await useVideoWorkbenchStore.getState().startCards(ids)
    setCard(ids[0], { status: 'succeeded' })
    expect(delivered).toHaveLength(0)
  })
})

// 渲染要几分钟,用户中途重启应用是常事(重启接管那条链就是为它建的)。而
// video_workbench_start 的横幅明说了「不要轮询,跑完会推给你」—— 那是一句承诺,
// 进程重启不能把它吞掉,否则 agent 永远静默等待,用户还得自己去捅它。
describe('批次登记跨重启存活', () => {
  /**
   * 模拟重启:新进程的模块内存是空的,但 localStorage 里的登记和 IndexedDB 里的
   * 卡片都还在。这里把落盘那份原样搬过去,再重新挂 watcher(挂载即恢复)。
   */
  function simulateRestart(): void {
    const persisted = globalThis.localStorage.getItem(AGENT_BATCH_STORAGE_KEY)
    __resetWorkbenchBatches()
    if (persisted !== null) globalThis.localStorage.setItem(AGENT_BATCH_STORAGE_KEY, persisted)
    unmount?.()
    unmount = mountWorkbenchBatchWatcher((notice) => delivered.push(notice))
  }

  it('重启前起的批次,重启后跑完照样推送', async () => {
    mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }, { prompt: '狗' }])
    await useVideoWorkbenchStore.getState().startCards(ids)
    registerAgentBatch(ids, 'th-1')

    simulateRestart()
    expect(delivered).toHaveLength(0) // 卡片还在飞,别急着推

    // 重启接管(reconcileInFlight)之后结果照常回流
    setCard(ids[0], { status: 'succeeded', remoteUrl: 'https://cos/cat.mp4' })
    setCard(ids[1], { status: 'succeeded', remoteUrl: 'https://cos/dog.mp4' })

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ threadId: 'th-1', total: 2, succeeded: 2 })
  })

  it('水合之前不结算 —— 否则恢复的批次会被当成「卡都没了」静默丢掉', async () => {
    mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    await useVideoWorkbenchStore.getState().startCards(ids)
    registerAgentBatch(ids, 'th-1')

    // 真实重启时 watcher 挂得比读库早:那一刻 store 里一张卡都没有,
    // 查不到的卡若算「已结算」,整批就会被判成无可汇报而丢弃。
    const inFlight = useVideoWorkbenchStore.getState().cards[0]
    useVideoWorkbenchStore.setState({ cards: [], hydrated: false })
    simulateRestart()
    expect(delivered).toHaveLength(0)

    // 读库把卡片和 hydrated 放在同一次 set 里落下(ensureHydrated 就是这么写的),
    // 所以订阅者看到 hydrated 时卡片必然已经在场。
    useVideoWorkbenchStore.setState({
      cards: [{ ...inFlight, status: 'succeeded' }],
      hydrated: true,
    })

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ total: 1, succeeded: 1 })
  })

  it('推送之后落盘登记就清空 —— 再重启不会把同一批重复汇报一遍', async () => {
    mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    await useVideoWorkbenchStore.getState().startCards(ids)
    registerAgentBatch(ids, 'th-1')
    setCard(ids[0], { status: 'succeeded' })
    expect(delivered).toHaveLength(1)

    simulateRestart()
    setCard(ids[0], { status: 'succeeded', remoteUrl: 'https://cos/cat.mp4' })
    expect(delivered).toHaveLength(1)
  })

  it('隔了一天的批次恢复时丢弃 —— 那时候的「渲染完成」已经是噪音', async () => {
    mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    await useVideoWorkbenchStore.getState().startCards(ids)
    registerAgentBatch(ids, 'th-1')

    // 把落盘登记的时间戳往前拨两天
    const stale = JSON.parse(globalThis.localStorage.getItem(AGENT_BATCH_STORAGE_KEY)!)
    for (const batch of stale) batch.createdAt = Date.now() - 2 * 24 * 60 * 60 * 1000
    __resetWorkbenchBatches()
    globalThis.localStorage.setItem(AGENT_BATCH_STORAGE_KEY, JSON.stringify(stale))
    unmount?.()
    unmount = mountWorkbenchBatchWatcher((notice) => delivered.push(notice))

    setCard(ids[0], { status: 'succeeded' })
    expect(delivered).toHaveLength(0)
  })

  it('落盘登记损坏时当没有批次,不抛错', () => {
    globalThis.localStorage.setItem(AGENT_BATCH_STORAGE_KEY, '{ 不是数组')
    expect(() => {
      unmount?.()
      unmount = mountWorkbenchBatchWatcher((notice) => delivered.push(notice))
    }).not.toThrow()
    expect(delivered).toHaveLength(0)
  })
})
