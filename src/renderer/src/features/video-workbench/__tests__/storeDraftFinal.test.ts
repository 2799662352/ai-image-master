// 样片升成片:1080p 或 4K。
//
// 协议(网关 new-api #111 / #113 + 4K):样片按 480p 出,满意后用**样片的网关任务号**再提交一次,
// 请求里只有 draft_task + resolution,其余沿用样片。4K 与 1080p 的区别只有 resolution 这一个字。
// 这里守渲染端的几件事:
//   - 点哪档发哪档(默认仍是 1080p,旧调用方不受影响);
//   - 卡片记住这一轮出的是哪档 —— 展示 / 估价 / 版本记录 / 详情都靠它;
//   - 下一次普通生成把它清掉,不让「4K」粘在后面的普通卡上。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
  versionSpecOf,
} from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'
import { useQuotaStore } from '../../../stores/useQuotaStore'

function mockApi() {
  const submit = vi.fn(async () => ({ success: true, taskId: 'task_final' }))
  ;(window as any).electronAPI = {
    videoWorkbench: { submit, reconcile: vi.fn(async () => []), repersist: vi.fn() },
  }
  return { submit }
}

/** 一张已经成功的 2.5 样片卡(平台余额)。 */
function addSucceededDraftCard(): string {
  const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '一只橘猫', model: '2.5' }])
  useVideoWorkbenchStore.setState((s) => ({
    cards: s.cards.map((c) =>
      c.id === id
        ? {
            ...c,
            draft: true,
            draftRun: true,
            status: 'succeeded' as const,
            taskId: 'task_draft',
            startedAt: Date.now() - 1000,
          }
        : c,
    ),
  }))
  return id
}

const cardOf = (id: string) => useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
  useQuotaStore.setState({ billingSource: 'platform' })
})

describe('finalizeDrafts 选分辨率', () => {
  it('不指定 = 1080p,与 4K 之前一模一样', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()

    const res = await useVideoWorkbenchStore.getState().finalizeDrafts([id])

    expect(res.started).toEqual([id])
    expect(submit.mock.calls[0][0]).toMatchObject({
      fromDraftTaskId: 'task_draft',
      resolution: '1080p',
      finalResolution: '1080p',
    })
    expect(cardOf(id)).toMatchObject({ fromDraftTaskId: 'task_draft', draftFinalResolution: '1080p' })
  })

  it('指定 4k:载荷与卡片都是 4k,走的仍是同一个样片任务号', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()

    await useVideoWorkbenchStore.getState().finalizeDrafts([id], '4k', { uhdConfirmed: true })

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toMatchObject({
      fromDraftTaskId: 'task_draft',
      resolution: '4k',
      finalResolution: '4k',
      billing: 'platform',
    })
    // 成片不带素材 / 种子:全部沿用样片(网关会拒重传)。
    expect(submit.mock.calls[0][0]).toMatchObject({ referenceImages: [], referenceVideos: [], referenceAudios: [] })
    // 状态不断言 preparing:mock 的 submit 立刻 resolve,卡片可能已经走到 queued,与本条无关。
    expect(cardOf(id)).toMatchObject({
      fromDraftTaskId: 'task_draft',
      draftFinalResolution: '4k',
      draftRun: undefined,
    })
    expect(['preparing', 'queued']).toContain(cardOf(id).status)
  })

  it('不认识的分辨率退回 1080p,不把脏值发给主进程', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()

    await useVideoWorkbenchStore.getState().finalizeDrafts([id], '720p' as never)

    expect(submit.mock.calls[0][0]).toMatchObject({ resolution: '1080p', finalResolution: '1080p' })
    expect(cardOf(id).draftFinalResolution).toBe('1080p')
  })

  it('自填 Key 下照旧被拦(样片只在平台余额里有),不会因为选了 4K 就绕过去', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()
    useQuotaStore.setState({ billingSource: 'own-key' })

    const res = await useVideoWorkbenchStore.getState().finalizeDrafts([id], '4k', { uhdConfirmed: true })

    expect(res.started).toEqual([])
    expect(res.skipped[0].reason).toContain('平台余额')
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('4K 成片这一轮的记录', () => {
  it('版本记录写 4k,并标明来自哪张样片', async () => {
    mockApi()
    const id = addSucceededDraftCard()
    await useVideoWorkbenchStore.getState().finalizeDrafts([id], '4k', { uhdConfirmed: true })

    expect(versionSpecOf(cardOf(id))).toMatchObject({ resolution: '4k', fromDraftTaskId: 'task_draft' })
  })

  it('旧成片(没有 draftFinalResolution)的版本记录仍是 1080p', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'x', model: '2.5' }])
    const old = { ...cardOf(id), fromDraftTaskId: 'task_old' }
    expect(versionSpecOf(old)).toMatchObject({ resolution: '1080p', fromDraftTaskId: 'task_old' })
  })

  it('下一次普通生成把「4K 成片」标记清掉', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()
    await useVideoWorkbenchStore.getState().finalizeDrafts([id], '4k', { uhdConfirmed: true })
    // 成片出来以后用户改了提示词再点「重新生成」:卡片是终态才能再提交。
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'failed' as const } : c)),
    }))

    await useVideoWorkbenchStore.getState().startCards([id])

    expect(submit).toHaveBeenCalledTimes(2)
    expect(cardOf(id).fromDraftTaskId).toBeUndefined()
    expect(cardOf(id).draftFinalResolution).toBeUndefined()
  })
})
