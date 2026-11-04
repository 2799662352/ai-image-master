// 4K 生成的二次确认闸 —— 「AI 不能代为确认」落在 store 这一层。
//
// 约定:
//   - 任何一次会真的提交 4K 的启动(普通生成 / 样片升 4K),store 默认拒绝,
//     只有调用方显式带 `uhdConfirmed: true` 才放行 —— 这个标记只由界面里
//     「两步确认」弹窗的最后一步传入;
//   - agent 入口(startCardsFromAgent)无论如何不放行,哪怕有人把标记塞进 opts;
//   - 被拒的卡不动状态(别留一张假的 preparing),回包带 `code` 让界面接着弹窗;
//   - 样片(480p)不算 4K,1080p 也不受影响。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UHD_CONFIRM_REQUIRED,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'
import { useQuotaStore } from '../../../stores/useQuotaStore'

function mockApi() {
  const submit = vi.fn(async () => ({ success: true, taskId: 'task_new' }))
  ;(window as any).electronAPI = {
    videoWorkbench: { submit, reconcile: vi.fn(async () => []), repersist: vi.fn() },
  }
  return { submit }
}

const store = () => useVideoWorkbenchStore.getState()
const cardOf = (id: string) => store().cards.find((c) => c.id === id)!

function addCard(patch: Record<string, unknown>): string {
  const [id] = store().addCards([{ prompt: '一只橘猫', ...patch } as never])
  return id
}

/** 一张已经成功的 2.5 样片卡(平台余额)。 */
function addSucceededDraftCard(): string {
  const id = addCard({ model: '2.5' })
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

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
  useQuotaStore.setState({ billingSource: 'platform' })
})

describe('startCards:4K 没有确认就不提交', () => {
  it('默认拒绝:不调用 submit、卡片原样不动、回包带 code', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })

    const res = await store().startCards([id])

    expect(submit).not.toHaveBeenCalled()
    expect(res.started).toEqual([])
    expect(res.skipped).toEqual([
      expect.objectContaining({ cardId: id, code: UHD_CONFIRM_REQUIRED, reason: expect.stringContaining('确认') }),
    ])
    expect(cardOf(id).status).toBe('draft')
    expect(cardOf(id).clientId).toBeUndefined()
  })

  it('带 uhdConfirmed 才放行,发出去的就是 4k', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })

    const res = await store().startCards([id], { uhdConfirmed: true })

    expect(res.started).toEqual([id])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toMatchObject({ resolution: '4k' })
  })

  it('同一批里:只拦 4K 的那张,其余照常提交', async () => {
    const { submit } = mockApi()
    const normal = addCard({ model: '2.0', resolution: '720p' })
    const uhd = addCard({ model: '2.0', resolution: '4k' })

    const res = await store().startCards([normal, uhd])

    expect(res.started).toEqual([normal])
    expect(res.skipped.map((s) => s.cardId)).toEqual([uhd])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toMatchObject({ resolution: '720p' })
  })

  it('整页启动(不点名)同样拦 4K', async () => {
    const { submit } = mockApi()
    const uhd = addCard({ model: '2.0', resolution: '4k' })

    const res = await store().startCards()

    expect(submit).not.toHaveBeenCalled()
    expect(res.skipped).toEqual([expect.objectContaining({ cardId: uhd, code: UHD_CONFIRM_REQUIRED })])
  })

  it('1080p 与样片不受影响:样片固定 480p,卡片上设着 4k 也不算 4K', async () => {
    const { submit } = mockApi()
    const hd = addCard({ model: '2.0', resolution: '1080p' })
    const draft = addCard({ model: '2.5', resolution: '4k', draft: true })

    const res = await store().startCards([hd, draft])

    expect(res.started).toEqual([hd, draft])
    expect(submit.mock.calls.map((c) => (c[0] as { resolution: string }).resolution)).toEqual(['1080p', '480p'])
  })

  it('自填 Key 直连的 4K(2.0)同样要确认,不分计费池', async () => {
    const { submit } = mockApi()
    useQuotaStore.setState({ billingSource: 'own-key' })
    const id = addCard({ model: '2.0', resolution: '4k' })

    const res = await store().startCards([id])

    expect(submit).not.toHaveBeenCalled()
    expect(res.skipped[0]).toMatchObject({ code: UHD_CONFIRM_REQUIRED })
  })
})

describe('startCardsFromAgent:AI 不能确认 4K', () => {
  beforeEach(() => {
    useVideoWorkbenchStore.setState({ agentAutoStart: true })
  })

  it('开着「允许 AI 自动生成」也不提交 4K,并给 agent 一句转告用户的话', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })

    const res = await store().startCardsFromAgent([id])

    expect(submit).not.toHaveBeenCalled()
    expect(res.started).toEqual([])
    expect(res.skipped[0]).toMatchObject({ cardId: id, code: UHD_CONFIRM_REQUIRED })
    expect(res.hint).toMatch(/用户/)
    expect(res.hint).toMatch(/4K/)
    expect(cardOf(id).status).toBe('draft')
  })

  it('即使 opts 里塞了 uhdConfirmed:true 也不认(agent 没有这个权限)', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })

    const res = await store().startCardsFromAgent([id], { uhdConfirmed: true })

    expect(submit).not.toHaveBeenCalled()
    expect(res.skipped[0]).toMatchObject({ code: UHD_CONFIRM_REQUIRED })
  })

  it('同批里非 4K 的卡照常提交', async () => {
    const { submit } = mockApi()
    const normal = addCard({ model: '2.0', resolution: '720p' })
    const uhd = addCard({ model: '2.0', resolution: '4k' })

    const res = await store().startCardsFromAgent([normal, uhd])

    expect(res.started).toEqual([normal])
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('没有 4K 被拦时不多出 hint', async () => {
    mockApi()
    const normal = addCard({ model: '2.0', resolution: '720p' })

    const res = await store().startCardsFromAgent([normal])

    expect(res.hint).toBeUndefined()
  })
})

describe('finalizeDrafts:样片升 4K 也要确认', () => {
  it('4K 没确认 → 拒绝,不提交,卡片还是那张成功的样片', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()

    const res = await store().finalizeDrafts([id], '4k')

    expect(submit).not.toHaveBeenCalled()
    expect(res.started).toEqual([])
    expect(res.skipped).toEqual([expect.objectContaining({ cardId: id, code: UHD_CONFIRM_REQUIRED })])
    expect(cardOf(id)).toMatchObject({ status: 'succeeded', draftRun: true, taskId: 'task_draft' })
    expect(cardOf(id).fromDraftTaskId).toBeUndefined()
  })

  it('确认后提交,走的是同一个样片任务号', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()

    const res = await store().finalizeDrafts([id], '4k', { uhdConfirmed: true })

    expect(res.started).toEqual([id])
    expect(submit.mock.calls[0][0]).toMatchObject({
      fromDraftTaskId: 'task_draft',
      resolution: '4k',
      finalResolution: '4k',
    })
  })

  it('1080p 成片(含 agent 的默认调用)不需要确认', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()

    const res = await store().finalizeDrafts([id])

    expect(res.started).toEqual([id])
    expect(submit.mock.calls[0][0]).toMatchObject({ resolution: '1080p', finalResolution: '1080p' })
  })

  it('不认识的分辨率退回 1080p,不会借「脏值」绕过也不会误当 4K', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()

    await store().finalizeDrafts([id], '4K ' as never)

    // coerce 会把大小写 / 空白归一成 4k —— 这是「选了 4K」,必须过确认闸。
    expect(submit).not.toHaveBeenCalled()
  })
})
