// 上游任务号(`upstreamTaskId`,火山 `cgt-…` / DashScope uuid)在渲染端的落点:
// 广播 → 卡片 → 版本存档 → MCP 快照 / IR 只读注解;重新生成时随上一轮结果一起清掉。
// 它是**结果不是意图**:不进 spec、不影响 specEquals,和 actualSeed 同一待遇。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../types/seedance'
import { resetWorkbenchStoreForTest, snapshotCard, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'
import { exportWorkbenchIR } from '../workbenchIR'
import { specEquals } from '../cardSpec'

const UPSTREAM = 'cgt-20260903172200-5n7rt'

function makeUpdate(patch: Partial<SeedanceTaskUpdate>): SeedanceTaskUpdate {
  return {
    taskId: 'task-1',
    prompt: 'p',
    model: '2.5',
    resolution: '480p',
    ratio: '16:9',
    duration: 6,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    persistence: 'idle',
    source: 'workbench',
    ...patch,
  }
}

async function submitOneCard(): Promise<string> {
  ;(window as any).electronAPI = {
    videoWorkbench: { submit: vi.fn(async () => ({ success: true, taskId: 'task-1' })) },
  }
  useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
  await useVideoWorkbenchStore.getState().startCards()
  return useVideoWorkbenchStore.getState().cards[0].clientId!
}

function card() {
  return useVideoWorkbenchStore.getState().cards[0]
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
})

describe('upstreamTaskId 落到卡片', () => {
  it('广播带来的上游任务号写进卡片;后续不带它的广播不把它抹掉', async () => {
    const clientId = await submitOneCard()
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'queued', upstreamTaskId: UPSTREAM }))
    expect(card().upstreamTaskId).toBe(UPSTREAM)

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running' }))
    expect(card().upstreamTaskId).toBe(UPSTREAM)
  })

  it('直连回形(广播从不带它)的卡片上它保持 undefined', async () => {
    const clientId = await submitOneCard()
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running' }))
    expect(card().upstreamTaskId).toBeUndefined()
  })

  it('上游任务号是结果不是意图:不改变 specEquals', async () => {
    const clientId = await submitOneCard()
    const before = card()
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running', upstreamTaskId: UPSTREAM }))
    expect(specEquals(before, card())).toBe(true)
  })

  it('成功那一轮的版本存档记下它;重新生成清掉卡上的,版本里的保留', async () => {
    const clientId = await submitOneCard()
    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, status: 'succeeded', localPath: 'C:/v1.mp4', persistence: 'done', upstreamTaskId: UPSTREAM }),
    )
    expect(card().versions?.[0]).toMatchObject({ seq: 1, taskId: 'task-1', upstreamTaskId: UPSTREAM })

    await useVideoWorkbenchStore.getState().startCards([card().id])
    expect(card().upstreamTaskId).toBeUndefined()
    expect(card().versions?.[0].upstreamTaskId).toBe(UPSTREAM)
  })
})

describe('submittedReferences(这一轮实际递给上游的素材地址)', () => {
  const REFS = { images: ['https://cos/a.png', 'https://cos/b.png'], videos: [], audios: [] }

  it('广播带来的 referenceUrls 落到卡片;成功后归档进版本;重新生成清掉卡上的', async () => {
    const clientId = await submitOneCard()
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'queued', referenceUrls: REFS }))
    expect(card().submittedReferences).toEqual(REFS)

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, status: 'succeeded', localPath: 'C:/v1.mp4', persistence: 'done', referenceUrls: REFS }),
    )
    expect(card().versions?.[0].submittedReferences).toEqual(REFS)

    await useVideoWorkbenchStore.getState().startCards([card().id])
    expect(card().submittedReferences).toBeUndefined()
    expect(card().versions?.[0].submittedReferences).toEqual(REFS)
  })

  it('不带 referenceUrls 的广播不抹掉已记下的', async () => {
    const clientId = await submitOneCard()
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'queued', referenceUrls: REFS }))
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running' }))
    expect(card().submittedReferences).toEqual(REFS)
  })
})

describe('upstreamTaskId 对 agent 可见', () => {
  it('detailed 快照带 upstreamTaskId;没有就不出现这个键', async () => {
    const clientId = await submitOneCard()
    expect(Object.hasOwn(snapshotCard(card()), 'upstreamTaskId')).toBe(false)
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running', upstreamTaskId: UPSTREAM }))
    expect(snapshotCard(card()).upstreamTaskId).toBe(UPSTREAM)
  })

  it('IR 导出的 result 只读注解带 upstreamTaskId', async () => {
    const clientId = await submitOneCard()
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running', upstreamTaskId: UPSTREAM }))
    const state = useVideoWorkbenchStore.getState()
    const ir = exportWorkbenchIR({
      cards: state.cards,
      boards: state.boards,
      activeProjectId: state.activeProjectId,
      activeBoardId: state.activeBoardId,
      revision: state.revision,
      structureRevision: state.structureRevision,
    })
    expect(ir.boards[0].cards[0].result).toMatchObject({ taskId: 'task-1', upstreamTaskId: UPSTREAM })
  })
})
