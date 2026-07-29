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
